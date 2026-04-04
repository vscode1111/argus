declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const api = acquireVsCodeApi();

export function postMessage(msg: object): void {
  api.postMessage(msg);
}
