import { icons as phIcons } from '@iconify-json/ph';
import { defineConfig, presetIcons, transformerDirectives } from 'unocss';
import { presetAnimations } from 'unocss-preset-animations';
import { presetWind4 } from 'unocss/preset-wind4';

/*
 * OBSIDIAN TERMINAL — Design System
 * Bloomberg Terminal meets luxury crypto.
 * Deep obsidian base, electric emerald for gains, crimson for losses, amber gold for rankings.
 */

const BASE_COLORS = {
  white: '#F0F0F5',
  black: '#0A0A0F',
  obsidian: {
    50: '#E8E8ED',
    100: '#C8C8D0',
    200: '#9898A5',
    300: '#6A6A7A',
    400: '#4A4A5C',
    500: '#35354A',
    600: '#2A2A3A',
    700: '#1E1E2C',
    800: '#15151F',
    900: '#0E0E16',
    950: '#0A0A0F',
  },
  emerald: {
    50: '#E8FFF3',
    100: '#C0FFE0',
    200: '#80FFBC',
    300: '#40FF99',
    400: '#00FF88',
    500: '#00D573',
    600: '#00AA5C',
    700: '#008048',
    800: '#005530',
    900: '#002B18',
    950: '#00150C',
  },
  crimson: {
    50: '#FFF0F2',
    100: '#FFD6DC',
    200: '#FFB0BC',
    300: '#FF8A9C',
    400: '#FF4D6A',
    500: '#FF3B5C',
    600: '#E5223E',
    700: '#B91C32',
    800: '#8C1525',
    900: '#5F0E18',
    950: '#33070D',
  },
  amber: {
    50: '#FFFBEB',
    100: '#FFF3C4',
    200: '#FFE68A',
    300: '#FFD54F',
    400: '#FFC107',
    500: '#FFB800',
    600: '#E5A500',
    700: '#B88000',
    800: '#8C6200',
    900: '#5F4200',
    950: '#332300',
  },
  blue: {
    50: '#EBF5FF',
    100: '#D6EBFF',
    200: '#B0D9FF',
    300: '#80C4FF',
    400: '#4AABFF',
    500: '#00B4FF',
    600: '#008FCC',
    700: '#006B99',
    800: '#004766',
    900: '#002433',
    950: '#00121A',
  },
  violet: {
    50: '#F5F0FF',
    100: '#E8DBFF',
    200: '#D1B8FF',
    300: '#B990FF',
    400: '#A370FF',
    500: '#8B5CF6',
    600: '#7040DC',
    700: '#5628B8',
    800: '#3F1D8C',
    900: '#2A1260',
    950: '#150933',
  },
} as const;

const COLOR_PRIMITIVES = {
  ...BASE_COLORS,
  alpha: {
    white: generateAlphaPalette('#F0F0F5'),
    black: generateAlphaPalette('#0A0A0F'),
    emerald: generateAlphaPalette('#00FF88'),
    crimson: generateAlphaPalette('#FF3B5C'),
    amber: generateAlphaPalette('#FFB800'),
    violet: generateAlphaPalette('#8B5CF6'),
    blue: generateAlphaPalette('#00B4FF'),
  },
} as const;

const SHADCN_COLORS = {
  background: 'hsl(var(--background))',
  foreground: 'hsl(var(--foreground))',
  card: {
    DEFAULT: 'hsl(var(--card))',
    foreground: 'hsl(var(--card-foreground))',
  },
  popover: {
    DEFAULT: 'hsl(var(--popover))',
    foreground: 'hsl(var(--popover-foreground))',
  },
  primary: {
    DEFAULT: 'hsl(var(--primary))',
    foreground: 'hsl(var(--primary-foreground))',
  },
  secondary: {
    DEFAULT: 'hsl(var(--secondary))',
    foreground: 'hsl(var(--secondary-foreground))',
  },
  muted: {
    DEFAULT: 'hsl(var(--muted))',
    foreground: 'hsl(var(--muted-foreground))',
  },
  accent: {
    DEFAULT: 'hsl(var(--accent))',
    foreground: 'hsl(var(--accent-foreground))',
  },
  destructive: {
    DEFAULT: 'hsl(var(--destructive))',
    foreground: 'hsl(var(--destructive-foreground))',
  },
  border: 'hsl(var(--border))',
  input: 'hsl(var(--input))',
  ring: 'hsl(var(--ring))',
  chart: {
    1: 'hsl(var(--chart-1))',
    2: 'hsl(var(--chart-2))',
    3: 'hsl(var(--chart-3))',
    4: 'hsl(var(--chart-4))',
    5: 'hsl(var(--chart-5))',
  },
} as const;

export default defineConfig({
  shortcuts: {
    'arena-ease': 'ease-[cubic-bezier(0.4,0,0.2,1)]',
    'transition-theme': 'transition-[background-color,border-color,color] duration-150 arena-ease',
    'glass': 'bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--glass-border)]',
    'glass-hover': 'hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-strong)]',
    'glass-strong': 'bg-[var(--glass-bg-strong)] backdrop-blur-2xl border border-[var(--glass-border)]',
    'text-glow-emerald': 'text-emerald-400 drop-shadow-[0_0_8px_rgba(0,255,136,0.4)]',
    'text-glow-crimson': 'text-crimson-400 drop-shadow-[0_0_8px_rgba(255,59,92,0.4)]',
    'text-glow-amber': 'text-amber-400 drop-shadow-[0_0_8px_rgba(255,184,0,0.4)]',
    'glow-border-emerald': 'shadow-[0_0_15px_rgba(0,255,136,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]',
    'glow-border-crimson': 'shadow-[0_0_15px_rgba(255,59,92,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]',
    'glow-border-amber': 'shadow-[0_0_15px_rgba(255,184,0,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]',
  },
  rules: [
    ['b', {}],
    [/^font-display$/, () => ({ 'font-family': "'Outfit', system-ui, sans-serif" })],
    [/^font-body$/, () => ({ 'font-family': "'DM Sans', system-ui, sans-serif" })],
    [/^font-data$/, () => ({ 'font-family': "'IBM Plex Mono', 'JetBrains Mono', monospace" })],
    [/^noise-bg$/, () => ({
      'background-image': "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E\")",
    })],
  ],
  theme: {
    animation: {
      keyframes: {
        'fade-in': '{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}}',
        'fade-in-up': '{0%{opacity:0;transform:translateY(20px)}100%{opacity:1;transform:translateY(0)}}',
        'glow-pulse': '{0%,100%{opacity:1}50%{opacity:0.6}}',
        'shimmer': '{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}',
        'ticker-scroll': '{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}',
        'gradient-shift': '{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}',
        'float': '{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}',
      },
      durations: {
        'ticker-scroll': '30s',
        'glow-pulse': '2s',
        'shimmer': '2s',
        'gradient-shift': '8s',
        'float': '6s',
      },
      timingFns: {
        'ticker-scroll': 'linear',
        'glow-pulse': 'ease-in-out',
        'shimmer': 'ease-in-out',
        'gradient-shift': 'ease',
        'float': 'ease-in-out',
      },
      counts: {
        'ticker-scroll': 'infinite',
        'glow-pulse': 'infinite',
        'shimmer': 'infinite',
        'gradient-shift': 'infinite',
        'float': 'infinite',
      },
    },
    colors: {
      ...COLOR_PRIMITIVES,
      ...SHADCN_COLORS,
      arena: {
        elements: {
          borderColor: 'var(--arena-elements-borderColor)',
          borderColorActive: 'var(--arena-elements-borderColorActive)',
          background: {
            depth: {
              1: 'var(--arena-elements-bg-depth-1)',
              2: 'var(--arena-elements-bg-depth-2)',
              3: 'var(--arena-elements-bg-depth-3)',
              4: 'var(--arena-elements-bg-depth-4)',
            },
          },
          textPrimary: 'var(--arena-elements-textPrimary)',
          textSecondary: 'var(--arena-elements-textSecondary)',
          textTertiary: 'var(--arena-elements-textTertiary)',
          button: {
            primary: {
              background: 'var(--arena-elements-button-primary-background)',
              backgroundHover: 'var(--arena-elements-button-primary-backgroundHover)',
              text: 'var(--arena-elements-button-primary-text)',
            },
            secondary: {
              background: 'var(--arena-elements-button-secondary-background)',
              backgroundHover: 'var(--arena-elements-button-secondary-backgroundHover)',
              text: 'var(--arena-elements-button-secondary-text)',
            },
            danger: {
              background: 'var(--arena-elements-button-danger-background)',
              backgroundHover: 'var(--arena-elements-button-danger-backgroundHover)',
              text: 'var(--arena-elements-button-danger-text)',
            },
          },
          icon: {
            success: 'var(--arena-elements-icon-success)',
            error: 'var(--arena-elements-icon-error)',
            primary: 'var(--arena-elements-icon-primary)',
            secondary: 'var(--arena-elements-icon-secondary)',
          },
          dividerColor: 'var(--arena-elements-dividerColor)',
          item: {
            backgroundHover: 'var(--arena-elements-item-backgroundHover)',
            backgroundActive: 'var(--arena-elements-item-backgroundActive)',
          },
          focus: 'var(--arena-elements-focus)',
        },
      },
    },
  },
  transformers: [transformerDirectives()],
  presets: [
    presetWind4({
      dark: {
        light: '[data-theme="light"]',
        dark: '[data-theme="dark"]',
      },
    }),
    presetAnimations(),
    presetIcons({
      warn: true,
      collections: {
        ph: () => phIcons,
      },
    }),
  ],
  safelist: [
    'i-ph:trophy',
    'i-ph:robot',
    'i-ph:chart-line-up',
    'i-ph:shield-check',
    'i-ph:wallet',
    'i-ph:rocket-launch',
    'i-ph:lightning',
    'i-ph:target',
    'i-ph:brain',
    'i-ph:chart-bar',
    'i-ph:coins',
    'i-ph:swap',
    'i-ph:arrow-clockwise',
    'i-ph:sun',
    'i-ph:moon',
    'i-ph:caret-down',
    'i-ph:magnifying-glass',
    'i-ph:trophy-fill',
    'i-ph:lightning-fill',
    'i-ph:shield-check-fill',
    'i-ph:rocket-launch-fill',
    'i-ph:pulse',
    'i-ph:chart-line',
    'i-ph:arrow-up-right',
    'i-ph:arrow-down-right',
    'i-ph:circle-fill',
    'i-ph:trend-up',
    'i-ph:trend-down',
    'i-ph:user',
    'i-ph:plus',
    'i-ph:gear',
  ],
});

function generateAlphaPalette(hex: string) {
  return [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100].reduce(
    (acc, opacity) => {
      const alpha = Math.round((opacity / 100) * 255)
        .toString(16)
        .padStart(2, '0');
      acc[opacity] = `${hex}${alpha}`;
      return acc;
    },
    {} as Record<number, string>,
  );
}
