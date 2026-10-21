declare module 'jsfive' {
  export class File {
    constructor(buffer: ArrayBuffer | Uint8Array, filename?: string);
    keys: string[];
    get(path: string): any;
  }
}
