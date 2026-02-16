export function Footer() {
  return (
    <footer className="border-t border-arena-elements-dividerColor py-5 mt-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center justify-between text-xs text-arena-elements-textTertiary">
        <span className="font-data">Trading Arena &middot; Tangle Network</span>
        <div className="flex items-center gap-5">
          <a href="https://github.com/tangle-network" target="_blank" rel="noopener noreferrer" className="hover:text-violet-700 dark:hover:text-violet-400 transition-colors">GitHub</a>
          <a href="https://docs.tangle.tools" target="_blank" rel="noopener noreferrer" className="hover:text-violet-700 dark:hover:text-violet-400 transition-colors">Docs</a>
        </div>
      </div>
    </footer>
  );
}
