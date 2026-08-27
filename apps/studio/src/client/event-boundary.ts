type ComposedSyntheticEvent<T extends EventTarget> = Readonly<{
  currentTarget: T;
  nativeEvent: Readonly<{ composedPath(): readonly EventTarget[] }>;
}>;

export function eventOriginatedWithinCurrentTarget<T extends EventTarget>(
  event: ComposedSyntheticEvent<T>,
): boolean {
  // React portals follow component ancestry, while composedPath reflects the
  // real DOM (including shadow hosts) that should own the interaction.
  return event.nativeEvent.composedPath().includes(event.currentTarget);
}
