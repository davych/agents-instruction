type NavigationGuard = () => boolean;

let activeGuard: NavigationGuard | undefined;

/** Registers the one active page-level guard and returns an ownership-safe cleanup. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = undefined;
  };
}

export function allowAppNavigation(): boolean {
  return activeGuard?.() ?? true;
}
