export function platformActorId(
  adapterName: string,
  userId: string,
): string {
  return `${adapterName}:${userId}`;
}

export function platformFromThreadId(
  threadId: string,
): string | null {
  const separator = threadId.indexOf(":");
  return separator > 0 ? threadId.slice(0, separator) : null;
}
