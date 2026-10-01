/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL override, e.g. http://192.168.100.9:3001. Blank → auto-detect from the page host. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
