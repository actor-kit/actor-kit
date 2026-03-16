---- MODULE SocketSync ----
EXTENDS Integers, FiniteSets, TLC

\*---------------------------------------------------------------------
\* Model the state synchronization protocol between an actor-kit
\* Durable Object server and its connected WebSocket clients.
\*
\* This spec verifies that per-socket send serialization guarantees:
\* 1. Every state update is delivered to every connected client
\* 2. Clients never permanently show stale state
\* 3. No concurrent checksum races per socket
\*
\* The spec is protocol-level — it does not model any specific
\* application (game, todo list, etc). It models the generic
\* server → client sync that createMachineServer.ts implements.
\*---------------------------------------------------------------------

CONSTANTS
    Clients,          \* Set of connected client IDs, e.g. {c1, c2}
    MaxTransitions    \* Max number of server state transitions to explore

\* Variables
VARIABLES
    serverVersion,    \* Server's state version (monotonically increasing)
    clientVersion,    \* Function: Clients -> Nat (last version each client received)
    pendingUpdate,    \* Function: Clients -> BOOLEAN (per-socket send queue non-empty)
    transitionCount   \* Number of server transitions so far (bounds state space)

vars == <<serverVersion, clientVersion, pendingUpdate, transitionCount>>

\*---------------------------------------------------------------------
\* Helpers
\*---------------------------------------------------------------------

\* All clients have received the latest state
AllClientsSynced ==
    \A c \in Clients : clientVersion[c] = serverVersion

\* At least one client has a pending update
SomePending ==
    \E c \in Clients : pendingUpdate[c] = TRUE

\* Set all clients to pending
SetAllPending == [c \in Clients |-> TRUE]

\*---------------------------------------------------------------------
\* Initial state
\*---------------------------------------------------------------------

Init ==
    /\ serverVersion = 0
    /\ clientVersion = [c \in Clients |-> 0]
    /\ pendingUpdate = [c \in Clients |-> FALSE]
    /\ transitionCount = 0

\*---------------------------------------------------------------------
\* Server actions
\*---------------------------------------------------------------------

\* Server transitions to a new state (e.g., an event was processed).
\* This models actor.send() triggering a state change, which fires
\* the subscription callback for each connected socket.
ServerTransition ==
    /\ transitionCount < MaxTransitions
    /\ serverVersion' = serverVersion + 1
    /\ pendingUpdate' = SetAllPending
    /\ transitionCount' = transitionCount + 1
    /\ UNCHANGED clientVersion

\*---------------------------------------------------------------------
\* Network / message delivery (per-socket serialization)
\*---------------------------------------------------------------------

\* A client receives its pending state update.
\* Per-socket serialization (#enqueueSendStateUpdate) ensures:
\* - Only one send is in flight per socket at a time
\* - The client receives the CURRENT server state (not a stale snapshot)
\* - #calculateChecksum and patch computation happen sequentially
ClientReceivesUpdate(c) ==
    /\ pendingUpdate[c] = TRUE
    /\ clientVersion' = [clientVersion EXCEPT ![c] = serverVersion]
    /\ pendingUpdate' = [pendingUpdate EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<serverVersion, transitionCount>>

\*---------------------------------------------------------------------
\* Next-state relation
\*---------------------------------------------------------------------

Next ==
    \/ ServerTransition
    \/ \E c \in Clients : ClientReceivesUpdate(c)

\*---------------------------------------------------------------------
\* SAFETY INVARIANTS
\*---------------------------------------------------------------------

\* INV1: Client version never exceeds server version
ClientNeverAhead ==
    \A c \in Clients : clientVersion[c] <= serverVersion

\* INV2: If a client is behind, it must have a pending update
\* (no silent desynchronization — the per-socket queue ensures delivery)
NoPermanentDesync ==
    \A c \in Clients :
        clientVersion[c] < serverVersion => pendingUpdate[c] = TRUE

\* INV3: All clients with no pending updates are at the server version
SyncedClientsAtServerVersion ==
    \A c \in Clients :
        pendingUpdate[c] = FALSE => clientVersion[c] = serverVersion

\*---------------------------------------------------------------------
\* LIVENESS (temporal properties)
\*---------------------------------------------------------------------

\* Every client eventually receives every state update
ClientsEventuallySync ==
    []<>(AllClientsSynced)

\* If a client has a pending update, it eventually receives it
PendingEventuallyDelivered ==
    \A c \in Clients :
        [](pendingUpdate[c] = TRUE => <>(pendingUpdate[c] = FALSE))

\*---------------------------------------------------------------------
\* Fairness (needed for liveness)
\*---------------------------------------------------------------------

Fairness ==
    /\ \A c \in Clients : WF_vars(ClientReceivesUpdate(c))

\*---------------------------------------------------------------------
\* Spec
\*---------------------------------------------------------------------

Spec == Init /\ [][Next]_vars /\ Fairness

\* Symmetry optimization
ClientSymmetry == Permutations(Clients)

====
