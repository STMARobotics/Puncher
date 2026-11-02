import { Puncher } from "./domain";
import { store } from "./runtime";
export async function handler() {
  const result = await new Puncher(store()).cleanup();
  console.log(JSON.stringify({ event: "cleanup.complete", ...result }));
  return result;
}
