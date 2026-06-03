import { Links, Meta, Scripts, ScrollRestoration } from 'react-router';
import type { ReactNode } from 'react';
import { inlineThemeBootScript } from '~/lib/theme/urlTheme';

interface ArenaDocumentProps {
  children: ReactNode;
  description: string;
}

const BRAND_ICON_VERSION = 'tangle-20260603';

// Replaces blueprint-ui's AppDocument so the inline theme-boot script can read
// `?theme=light|dark` from the URL before the React bundle hydrates. The parent
// shell (Tangle Cloud dapp) reloads the iframe with its current theme on every
// surface change, so URL takes precedence over localStorage on first paint.
export function ArenaDocument({ children, description }: ArenaDocumentProps) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={description} />
        <Meta />
        <Links />
        <link rel="icon" href={`/favicon.svg?v=${BRAND_ICON_VERSION}`} type="image/svg+xml" />
        <link rel="icon" href={`/favicon-32.png?v=${BRAND_ICON_VERSION}`} sizes="32x32" type="image/png" />
        <link rel="icon" href={`/favicon-16.png?v=${BRAND_ICON_VERSION}`} sizes="16x16" type="image/png" />
        <link rel="shortcut icon" href={`/favicon.ico?v=${BRAND_ICON_VERSION}`} />
        <link rel="apple-touch-icon" href={`/apple-touch-icon.png?v=${BRAND_ICON_VERSION}`} sizes="180x180" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&family=Outfit:wght@400;500;600;700;800;900&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: inlineThemeBootScript }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
