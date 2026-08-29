// Intentionally buggy: the reducer subtracts instead of adding.
// The eval's write task is to make the harness find and fix this.
export function sum(values) {
  return values.reduce((total, value) => total - value, 0);
}
