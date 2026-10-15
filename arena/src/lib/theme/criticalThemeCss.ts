import brandTokens from '@tangle-network/brand/styles/tokens.css?raw';

// Resolve first-paint colors from the same Brand sheet as the application.
export const criticalThemeCss = `${brandTokens}\nhtml{background-color:var(--depth-1)}`;
