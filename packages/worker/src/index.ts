// @actor-kit/worker — actor, message, runtime, identity

export type { TypedActorClass } from "./actor";
// Core actor builder + typed DO class
export { actor, createActorClass } from "./actor";
// Contract builder
export type { ActorContract, LifecycleEvent } from "./define";
export { defineActor } from "./define";
// Identity (Worker-trust model)
export { CALLER_ID_HEADER, CALLER_TYPE_HEADER, withCallerIdentity } from "./identity";
// Link declaration
export type { LinkContext, LinkDef, LinkErrorCode, LinkHandlers } from "./link";
export { link } from "./link";
// Message helpers
export type { PlainMessageContext } from "./message";
export { message } from "./message";
// Actor references
export type { ActorRef, LocationHint } from "./ref";
export { createRef } from "./ref";
// Effect metadata (ADR-016 §1): what a service's third argument and a forward's ctx.delivery carry
export type { DeliveryInfo, EffectInfo } from "./runtime/effect-info";
// Typed env (ADR-016 §4): binding helpers for the `env` schema
export type { EnvIssue } from "./runtime/env";
export { d1, durableObject, kv, queue, r2, service } from "./runtime/env";
export { getTokenFromRequest } from "./runtime/get-token";
// Namespace resolution
export { resolveNamespace } from "./runtime/resolve-namespace";
export type { ActorRoute } from "./runtime/route-to-actor";
// Runtime utilities
export { parseActorRoute } from "./runtime/route-to-actor";
// Typed service errors (ADR-016 §2): `throw fail({ _tag, ... })` from a service's fn
export type { BuiltInError, DefectError, ServiceError, TaggedError, TimeoutError } from "./runtime/service-error";
export { fail, ServiceFailure } from "./runtime/service-error";
// Typed version chain (ADR-015 D5)
export type { VersionDef, VersionOptions } from "./runtime/versions";
export { version } from "./runtime/versions";
// Typed declarations: setup({ events, states }) (ADR-017)
export type {
  EmittingMessageContext,
  EmittingTimerContext,
  EventPayloads,
  EventSchemas,
  Goto,
  KitActorDef,
  KitContractDef,
  KitDefCheck,
  KitServiceDef,
  LocalOf,
  PhasedState,
  PhasedStateOf,
  PhaseResult,
  Setup,
  StateDecl,
  TypedEmit,
  TypedStateDef,
} from "./setup";
export { goto, PhaseTransition, setup, stay } from "./setup";
// Timer helper (ADR-015 D2)
export type { PlainTimerContext } from "./timer";
export { timer } from "./timer";
