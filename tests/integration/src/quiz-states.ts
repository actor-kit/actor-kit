/** The quiz example (states with typed locals, ADR-017 §1) hosted in the integration Worker. */
import { createActorClass } from "@actor-kit/worker";
import { QuizContract } from "../../../examples/quiz/quiz";

export { QuizContract };
export const QuizStates = createActorClass(QuizContract);
