/**
 * The runtime check that a definition has the shape the actor runtime needs: object `input`,
 * `roles` and `views`, an `init` function, and (when present) links that each name a `contract`
 * and an `onUpdate`.
 */
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const OBJECT_PARTS = ["input", "roles", "views"] as const;

const isLinkDef = (value: unknown): boolean => isObject(value) && "contract" in value && "onUpdate" in value;

function linksAreValid(links: unknown): boolean {
  if (links === undefined) return true;
  return isObject(links) && Object.values(links).every(isLinkDef);
}

export function hasActorDefShape(def: unknown): boolean {
  if (!isObject(def)) return false;
  return (
    OBJECT_PARTS.every((part) => isObject(Reflect.get(def, part))) &&
    typeof Reflect.get(def, "init") === "function" &&
    linksAreValid(Reflect.get(def, "links"))
  );
}
