import type { DirectoryPerson } from "./roster";
// Imported by local.ts only; production entrypoints do not import this adapter.
export const localDirectory: DirectoryPerson[] = [
  {
    id: "local-student",
    displayName: "Alex Example",
    email: "local-student@stmarobotics.org",
    active: true,
  },
  {
    id: "synthetic-jordan",
    displayName: "Jordan Sample",
    email: "jordan@stmarobotics.org",
    active: true,
  },
  {
    id: "synthetic-casey",
    displayName: "Casey Volunteer",
    email: "casey@stmarobotics.org",
    active: true,
  },
];
