let ready = false;

export function setApplicationReady(value: boolean): void {
  ready = value;
}

export function isApplicationReady(): boolean {
  return ready;
}
