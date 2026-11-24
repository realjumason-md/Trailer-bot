export type CriticalChildFailure =
  | { type: "error"; error: Error }
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    };

type ChildProcessEvents = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export function watchCriticalChildProcessFailure(
  child: ChildProcessEvents,
  isStopping: () => boolean,
  onFailure: (failure: CriticalChildFailure) => void,
): void {
  child.once("error", (error) => {
    if (!isStopping()) onFailure({ type: "error", error });
  });
  child.once("exit", (code, signal) => {
    if (!isStopping()) onFailure({ type: "exit", code, signal });
  });
}
