export function useAutoScroll() {
  return {
    containerRef: { current: null },
    endRef: { current: null },
  };
}

export function useRunCollapseState() {
  return {
    collapsedRuns: new Set<string>(),
    toggleRun: () => {},
  };
}

export function useRunGroups() {
  return [];
}
