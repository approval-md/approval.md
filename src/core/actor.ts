/** True for principals permitted to request or execute: people and agents. */
export function isPrincipalActor(actor: string): boolean {
  return /^(human|agent):.+/u.test(actor);
}
