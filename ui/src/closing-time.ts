import { Midi } from "@tonejs/midi";
import * as Tone from "tone";

let midiData: Promise<ArrayBuffer> | undefined;

export function primeClosingTimeAudio() {
  return Tone.start()
    .then(() => true)
    .catch(() => false);
}

export async function playClosingTime() {
  midiData ??= fetch("/Semisonic_-_Closing_Time.mid").then((response) => {
    if (!response.ok) throw new Error("Unable to load Closing Time MIDI.");
    return response.arrayBuffer();
  });
  const midi = new Midi(await midiData);
  await Tone.start();
  const synth = new Tone.PolySynth(Tone.Synth).toDestination();
  const startAt = Tone.now() + 0.1;
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      synth.triggerAttackRelease(
        note.name,
        note.duration,
        startAt + note.time,
        note.velocity,
      );
    }
  }
}
