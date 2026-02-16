export function Footer() {
  return (
    <footer className="border-t border-arena-elements-dividerColor py-10 mt-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3 text-sm text-arena-elements-textTertiary">
            <div className="flex items-center gap-2">
              <div className="i-ph:lightning-fill text-emerald-500/60" />
              <span className="font-display font-medium text-arena-elements-textSecondary">
                Trading Arena
              </span>
            </div>
            <span className="text-arena-elements-textTertiary">|</span>
            <span>Built on Tangle Network</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <a
              href="https://github.com/tangle-network"
              target="_blank"
              rel="noopener noreferrer"
              className="text-arena-elements-textTertiary hover:text-emerald-400 transition-colors duration-200"
            >
              GitHub
            </a>
            <a
              href="https://docs.tangle.tools"
              target="_blank"
              rel="noopener noreferrer"
              className="text-arena-elements-textTertiary hover:text-emerald-400 transition-colors duration-200"
            >
              Docs
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
