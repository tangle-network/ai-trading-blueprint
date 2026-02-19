import { reactRouter } from '@react-router/dev/vite';
import UnoCSS from 'unocss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// SSR browser globals shim — web3 libraries (mipd, sonner, @tangle/agent-ui)
// access document/window at module scope. Vite's SSR module runner evaluates
// code in an isolated context, so Node-level globals don't help. This plugin
// prepends a shim to every JS module that references browser APIs during SSR.
function ssrBrowserShim(): Plugin {
  const shim = [
    // document
    `if(typeof document==='undefined'){`,
    `var __n=function(){return{}};`,
    `var __el=function(){return{innerHTML:'',textContent:'',style:{},`,
    `setAttribute:__n,getAttribute:__n,addEventListener:__n,removeEventListener:__n,`,
    `appendChild:__n,removeChild:__n,insertBefore:__n,replaceChild:__n,`,
    `cloneNode:function(){return __el()},`,
    `querySelectorAll:function(){return[]},querySelector:function(){return null},`,
    `getElementsByTagName:function(){return[]},getElementsByClassName:function(){return[]},`,
    `getBoundingClientRect:function(){return{top:0,left:0,right:0,bottom:0,width:0,height:0}},`,
    `classList:{add:__n,remove:__n,toggle:__n,contains:function(){return false}},`,
    `dataset:{},childNodes:[],children:[],parentNode:null,parentElement:null,`,
    `nextSibling:null,previousSibling:null,firstChild:null,lastChild:null,`,
    `nodeType:1,tagName:'DIV',nodeName:'DIV',ownerDocument:null}};`,
    `globalThis.document={createElement:__el,createElementNS:__el,`,
    `createTextNode:function(){return{nodeType:3,textContent:''}},`,
    `createDocumentFragment:function(){return{appendChild:__n,childNodes:[]}},`,
    `createComment:function(){return{nodeType:8}},`,
    `getElementsByTagName:function(){return[]},getElementsByClassName:function(){return[]},`,
    `getElementById:function(){return null},querySelector:function(){return null},`,
    `querySelectorAll:function(){return[]},`,
    `head:__el(),body:__el(),`,
    `documentElement:{setAttribute:__n,getAttribute:__n,style:{},`,
    `classList:{add:__n,remove:__n,toggle:__n,contains:function(){return false}}},`,
    `addEventListener:__n,removeEventListener:__n,`,
    `createEvent:function(){return{initEvent:__n}},`,
    `createRange:function(){return{setStart:__n,setEnd:__n,`,
    `commonAncestorContainer:{nodeName:'BODY',ownerDocument:globalThis.document},`,
    `createContextualFragment:function(){return{appendChild:__n,childNodes:[]}}}},`,
    `cookie:'',readyState:'complete',title:'',URL:'http://localhost/'}}`,
    // window
    `if(typeof window==='undefined'){`,
    `globalThis.window=globalThis;`,
    `var __ws={addEventListener:function(){},removeEventListener:function(){},`,
    `dispatchEvent:function(){return true},`,
    `matchMedia:function(){return{matches:false,media:'',addListener:function(){},`,
    `removeListener:function(){},addEventListener:function(){},removeEventListener:function(){}}},`,
    `getComputedStyle:function(){return new Proxy({},{get:function(){return''}})},`,
    `localStorage:{getItem:function(){return null},setItem:function(){},removeItem:function(){},clear:function(){}},`,
    `sessionStorage:{getItem:function(){return null},setItem:function(){},removeItem:function(){},clear:function(){}},`,
    `requestAnimationFrame:function(cb){return setTimeout(cb,0)},`,
    `cancelAnimationFrame:function(id){clearTimeout(id)},`,
    `CustomEvent:function(t,p){return{type:t,detail:p&&p.detail}},`,
    `Event:function(t){return{type:t}},`,
    `location:{href:'http://localhost/',protocol:'https:',host:'localhost',hostname:'localhost',port:'',pathname:'/',search:'',hash:''},`,
    `history:{pushState:function(){},replaceState:function(){},back:function(){},forward:function(){}},`,
    `screen:{width:1920,height:1080},innerWidth:1920,innerHeight:1080,outerWidth:1920,outerHeight:1080,`,
    `devicePixelRatio:1,scrollX:0,scrollY:0,pageXOffset:0,pageYOffset:0,`,
    `scroll:function(){},scrollTo:function(){},scrollBy:function(){},`,
    `getSelection:function(){return{removeAllRanges:function(){},addRange:function(){}}},`,
    `ResizeObserver:function(){return{observe:function(){},unobserve:function(){},disconnect:function(){}}},`,
    `MutationObserver:function(){return{observe:function(){},disconnect:function(){}}},`,
    `IntersectionObserver:function(){return{observe:function(){},unobserve:function(){},disconnect:function(){}}}};`,
    `for(var __k in __ws){if(!(__k in globalThis)){try{globalThis[__k]=__ws[__k]}catch(e){}}}}`,
    // navigator
    `if(typeof navigator==='undefined'){globalThis.navigator={userAgent:'node',language:'en',languages:['en'],platform:'linux',`,
    `clipboard:{writeText:function(){return Promise.resolve()},readText:function(){return Promise.resolve('')}},onLine:true}}`,
    // DOM classes
    `if(typeof HTMLElement==='undefined'){globalThis.HTMLElement=function(){}}`,
    `if(typeof Element==='undefined'){globalThis.Element=function(){}}`,
    `if(typeof SVGElement==='undefined'){globalThis.SVGElement=function(){}}`,
    `if(typeof DOMParser==='undefined'){globalThis.DOMParser=function(){return{parseFromString:function(){return globalThis.document}}}}`,
    `\n`,
  ].join('');

  return {
    name: 'ssr-browser-shim',
    enforce: 'pre',
    transform(code, id, options) {
      if (!options?.ssr) return;
      // Only transform JS/TS modules, never CSS/JSON/assets
      if (!/\.(m?[jt]sx?)([\?#]|$)/.test(id)) return;
      // Only shim modules that actually reference browser globals
      if (
        !code.includes('document') &&
        !code.includes('window') &&
        !code.includes('navigator') &&
        !code.includes('HTMLElement')
      )
        return;
      return { code: shim + code, map: null };
    },
  };
}

function clientChunks(): Plugin {
  return {
    name: 'client-chunks',
    config(_, { isSsrBuild }) {
      if (!isSsrBuild) {
        return {
          build: {
            rollupOptions: {
              output: {
                manualChunks: {
                  'react-vendor': ['react', 'react-dom', 'react-router'],
                  'web3-vendor': ['wagmi', 'viem', '@tanstack/react-query', 'connectkit'],
                  'chart-vendor': ['chart.js', 'react-chartjs-2'],
                  'motion-vendor': ['framer-motion'],
                },
              },
            },
          },
        };
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env/.env.local so VITE_RPC_URL is available for proxy config.
  // process.env.VITE_* is NOT populated when vite.config.ts runs — must use loadEnv().
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const rpcTarget = env.VITE_RPC_URL || 'http://127.0.0.1:8545';

  return {
  plugins: [
    ssrBrowserShim(),
    UnoCSS(),
    reactRouter(),
    tsconfigPaths(),
    clientChunks(),
  ],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      events: 'events',
    },
    dedupe: [
      '@nanostores/react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs',
      '@tangle/agent-ui',
      'blo',
      'class-variance-authority',
      'clsx',
      'framer-motion',
      'nanostores',
      'react',
      'react-dom',
      'tailwind-merge',
      'viem',
      'wagmi',
    ],
  },
  server: {
    port: 1337,
    host: '0.0.0.0',
    proxy: {
      // Proxy operator API calls to avoid CORS issues in development
      '/operator-api': {
        target: 'http://localhost:9200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/operator-api/, ''),
      },
      // Proxy RPC calls so browsers on non-localhost (Tailscale, LAN) can reach Anvil
      '/rpc-proxy': {
        target: rpcTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc-proxy/, ''),
      },
    },
  },
};
});
