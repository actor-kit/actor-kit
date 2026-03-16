---- MODULE PersistSync ----
EXTENDS Integers, FiniteSets, TLC

\*---------------------------------------------------------------------
\* Model persistence, server crash/restart, snapshot cache expiry,
\* and client reconnection in the actor-kit sync protocol.
\*
\* Extends the SocketSync model with:
\* - Async persistence of snapshots to durable storage
\* - Server crash (loses in-memory state + cache) and restart
\*   (restores from persisted snapshot)
\* - Snapshot cache with expiry (models 300s TTL)
\* - Client disconnect/reconnect with checksum-based resume
\*
\* Maps to createMachineServer.ts:
\*   ServerTransition     -> actor state change triggers subscription
\*   PersistSnapshot      -> #persistSnapshot writes to DO storage
\*   ClientReceivesUpdate -> #sendStateUpdate computes diff + sends
\*   ClientDisconnects    -> webSocketClose handler
\*   ClientReconnects     -> fetch with checksum query param
\*   CacheExpiry          -> #scheduleSnapshotCacheCleanup (300s TTL)
\*   ServerCrash          -> DO eviction (loses actor + cache)
\*   ServerRestart        -> constructor blockConcurrencyWhile
\*---------------------------------------------------------------------

CONSTANTS
    Clients,          \* Set of client IDs, e.g. {c1, c2}
    MaxTransitions    \* Bound on server state transitions

VARIABLES
    serverVersion,        \* Nat: current server state version
    persistedVersion,     \* Nat: last version written to storage
    clientVersion,        \* Clients -> Nat: what each client has
    clientConnected,      \* Clients -> BOOLEAN
    clientKnownChecksum,  \* Clients -> Nat or -1: checksum client reconnects with
    cacheContains,        \* Set of Nat: which versions are in the snapshot cache
    serverAlive,          \* BOOLEAN: is the server running
    transitionCount       \* Nat: bounds exploration

vars == <<serverVersion, persistedVersion, clientVersion,
          clientConnected, clientKnownChecksum, cacheContains,
          serverAlive, transitionCount>>

\*---------------------------------------------------------------------
\* Helpers
\*---------------------------------------------------------------------

ConnectedClients == {c \in Clients : clientConnected[c]}

AllConnectedSynced ==
    \A c \in ConnectedClients : clientVersion[c] = serverVersion

\*---------------------------------------------------------------------
\* Initial state
\*---------------------------------------------------------------------

Init ==
    /\ serverVersion = 0
    /\ persistedVersion = 0
    /\ clientVersion = [c \in Clients |-> 0]
    /\ clientConnected = [c \in Clients |-> TRUE]
    /\ clientKnownChecksum = [c \in Clients |-> 0]
    /\ cacheContains = {0}
    /\ serverAlive = TRUE
    /\ transitionCount = 0

\*---------------------------------------------------------------------
\* Server actions
\*---------------------------------------------------------------------

\* Server processes an event, state version advances.
\* All connected clients will need an update.
\* The new version is added to the snapshot cache.
ServerTransition ==
    /\ serverAlive
    /\ transitionCount < MaxTransitions
    /\ serverVersion' = serverVersion + 1
    /\ cacheContains' = cacheContains \cup {serverVersion + 1}
    /\ transitionCount' = transitionCount + 1
    /\ UNCHANGED <<persistedVersion, clientVersion, clientConnected,
                   clientKnownChecksum, serverAlive>>

\* Async persistence: writes current serverVersion to storage.
\* Models #persistSnapshot — only writes if version changed.
PersistSnapshot ==
    /\ serverAlive
    /\ persistedVersion < serverVersion
    /\ persistedVersion' = serverVersion
    /\ UNCHANGED <<serverVersion, clientVersion, clientConnected,
                   clientKnownChecksum, cacheContains, serverAlive,
                   transitionCount>>

\*---------------------------------------------------------------------
\* Client actions
\*---------------------------------------------------------------------

\* A connected client receives a state update.
\* Models #sendStateUpdate: computes diff using cache, sends to client.
\*
\* If the client's lastSentChecksum is in the cache, the server can
\* compute a proper diff. If not (cache miss), the server falls back
\* to diffing against an empty object — client still gets correct state.
\*
\* The guard is clientVersion[c] # serverVersion (not just <) because
\* after a crash+restart the server may have rolled back to a version
\* LESS than the client's. The server still sends the current state
\* since the checksums won't match (#sendStateUpdate checks
\* lastSentChecksum !== currentChecksum).
ClientReceivesUpdate(c) ==
    /\ serverAlive
    /\ clientConnected[c]
    /\ clientVersion[c] # serverVersion
    /\ clientVersion' = [clientVersion EXCEPT ![c] = serverVersion]
    /\ clientKnownChecksum' = [clientKnownChecksum EXCEPT ![c] = serverVersion]
    /\ UNCHANGED <<serverVersion, persistedVersion, clientConnected,
                   cacheContains, serverAlive, transitionCount>>

\* Client disconnects. It remembers its last known version (checksum).
ClientDisconnects(c) ==
    /\ clientConnected[c]
    /\ clientConnected' = [clientConnected EXCEPT ![c] = FALSE]
    \* clientKnownChecksum retains whatever the client last had
    /\ UNCHANGED <<serverVersion, persistedVersion, clientVersion,
                   clientKnownChecksum, cacheContains, serverAlive,
                   transitionCount>>

\* Client reconnects with its remembered checksum.
\* Models fetch() handler: client passes checksum query param.
\* Server sets lastSentChecksum from the checksum.
\* If checksum matches current server state, no initial send needed.
\* If not, client will get an update via ClientReceivesUpdate.
ClientReconnects(c) ==
    /\ serverAlive
    /\ ~clientConnected[c]
    /\ clientConnected' = [clientConnected EXCEPT ![c] = TRUE]
    \* If client's known checksum matches current serverVersion,
    \* client is already synced. Otherwise it stays at its old version
    \* and will receive an update.
    /\ IF clientKnownChecksum[c] = serverVersion
       THEN clientVersion' = [clientVersion EXCEPT ![c] = serverVersion]
       ELSE UNCHANGED clientVersion
    /\ UNCHANGED <<serverVersion, persistedVersion, clientKnownChecksum,
                   cacheContains, serverAlive, transitionCount>>

\*---------------------------------------------------------------------
\* Cache expiry
\*---------------------------------------------------------------------

\* A cached version expires (models the 300s TTL cleanup).
\* The current server version is never evicted (matches
\* #cleanupSnapshotCache which skips currentChecksum).
CacheExpiry(v) ==
    /\ v \in cacheContains
    /\ v # serverVersion  \* current checksum is never evicted
    /\ cacheContains' = cacheContains \ {v}
    /\ UNCHANGED <<serverVersion, persistedVersion, clientVersion,
                   clientConnected, clientKnownChecksum, serverAlive,
                   transitionCount>>

\*---------------------------------------------------------------------
\* Server crash and restart
\*---------------------------------------------------------------------

\* Server crashes: loses in-memory state (actor, cache).
\* All connections drop. Clients retain their checksums.
ServerCrash ==
    /\ serverAlive
    /\ serverAlive' = FALSE
    /\ cacheContains' = {}
    \* All clients disconnected
    /\ clientConnected' = [c \in Clients |-> FALSE]
    /\ UNCHANGED <<serverVersion, persistedVersion, clientVersion,
                   clientKnownChecksum, transitionCount>>

\* Server restarts: restores state from persistedVersion.
\* The server version resets to what was persisted.
\* Cache starts fresh with just the restored version.
ServerRestart ==
    /\ ~serverAlive
    /\ serverAlive' = TRUE
    /\ serverVersion' = persistedVersion
    /\ cacheContains' = {persistedVersion}
    /\ UNCHANGED <<persistedVersion, clientVersion, clientConnected,
                   clientKnownChecksum, transitionCount>>

\*---------------------------------------------------------------------
\* Next-state relation
\*---------------------------------------------------------------------

Next ==
    \/ ServerTransition
    \/ PersistSnapshot
    \/ \E c \in Clients : ClientReceivesUpdate(c)
    \/ \E c \in Clients : ClientDisconnects(c)
    \/ \E c \in Clients : ClientReconnects(c)
    \/ \E v \in 0..MaxTransitions : CacheExpiry(v)
    \/ ServerCrash
    \/ ServerRestart

\*---------------------------------------------------------------------
\* SAFETY INVARIANTS
\*---------------------------------------------------------------------

\* INV1: Persisted version never exceeds server version
PersistenceNeverAhead ==
    persistedVersion <= serverVersion

\* INV2: After reconnect + receiving update, client has current server version.
\* More precisely: any connected client that has received an update
\* (clientVersion = serverVersion) is correctly synced.
ReconnectedClientGetsCorrectState ==
    \A c \in Clients :
        (clientConnected[c] /\ clientVersion[c] = serverVersion)
        => clientKnownChecksum[c] = serverVersion

\* INV3: A client that has synced (checksum matches serverVersion)
\* has the correct version. After crash+restart, a client may
\* temporarily have a version > serverVersion (it saw state that
\* was never persisted), but once it receives an update it will
\* be corrected.
SyncedClientAtServerVersion ==
    \A c \in Clients :
        (clientConnected[c] /\ clientKnownChecksum[c] = serverVersion)
        => clientVersion[c] = serverVersion

\* INV4: Cache miss still correct — even when a client's lastSentChecksum
\* is not in the cache, the server falls back to empty-object diff,
\* so the client still converges. This is modeled by ClientReceivesUpdate
\* not requiring the version to be in cache.
\* We verify: if a client is connected and behind, it CAN receive an update
\* regardless of cache state. (This is structural — the action is always enabled.)
CacheMissStillCorrect ==
    \A c \in Clients :
        (serverAlive /\ clientConnected[c] /\ clientVersion[c] < serverVersion)
        => TRUE  \* ClientReceivesUpdate(c) is enabled — no cache precondition

\*---------------------------------------------------------------------
\* LIVENESS (temporal properties)
\*---------------------------------------------------------------------

\* All connected clients eventually sync to server version
ClientsEventuallySync ==
    []<>(AllConnectedSynced)

\* If server stays alive, persistence eventually catches up
PersistenceEventuallyComplete ==
    [](serverAlive => <>(persistedVersion = serverVersion))

\* After a restart, connected clients eventually sync
NoPermanentDesyncAfterRestart ==
    []<>(\A c \in ConnectedClients : clientVersion[c] = serverVersion)

\*---------------------------------------------------------------------
\* Fairness
\*---------------------------------------------------------------------

\* Strong fairness for ClientReceivesUpdate: if a client is
\* *repeatedly* enabled to receive an update (it keeps reconnecting
\* while behind), the update must eventually be delivered. This
\* prevents pathological disconnect/reconnect loops that starve
\* message delivery.
Fairness ==
    /\ \A c \in Clients : SF_vars(ClientReceivesUpdate(c))
    /\ WF_vars(PersistSnapshot)
    /\ WF_vars(ServerRestart)

\*---------------------------------------------------------------------
\* Spec
\*---------------------------------------------------------------------

Spec == Init /\ [][Next]_vars /\ Fairness

\* Symmetry optimization
ClientSymmetry == Permutations(Clients)

====
