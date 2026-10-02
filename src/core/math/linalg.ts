/**
 * Minimal dense linear algebra.
 *
 * Deliberately dependency-free: this runs inside a service-worker-cached PWA that
 * must work offline on a mid-range phone, so pulling in a matrix library (or
 * OpenCV.js, at ~8 MB) for what amounts to two solvers is not a good trade.
 *
 * Matrices are row-major arrays of arrays.
 */

export type Matrix = number[][];
export type Vector = number[];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length;
  const cols = a[0].length;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) out[j][i] = a[i][j];
  }
  return out;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0].length;
  if (a[0].length !== inner) {
    throw new Error(`Dimension mismatch: ${a.length}x${a[0].length} * ${b.length}x${b[0].length}`);
  }
  const out = zeros(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < cols; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

export function matVec(a: Matrix, v: Vector): Vector {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * v[j], 0));
}

/**
 * Solves `A x = b` by Gaussian elimination with partial pivoting.
 *
 * Returns null when the matrix is singular to working precision, which callers
 * must treat as "this measurement is unusable" rather than substituting a
 * fallback. Silently returning a garbage solution here would surface as a
 * confidently wrong test classification, which is the worst possible failure
 * mode for this application.
 */
export function solve(a: Matrix, b: Vector): Vector | null {
  const n = a.length;
  if (n === 0 || a[0].length !== n || b.length !== n) {
    throw new Error('solve() requires a square system with a matching right-hand side');
  }

  // Work on copies; callers reuse their inputs.
  const m: Matrix = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotMagnitude = Math.abs(m[col][col]);
    for (let row = col + 1; row < n; row++) {
      const magnitude = Math.abs(m[row][col]);
      if (magnitude > pivotMagnitude) {
        pivotMagnitude = magnitude;
        pivotRow = row;
      }
    }

    if (pivotMagnitude < 1e-12) return null;

    if (pivotRow !== col) {
      const swap = m[col];
      m[col] = m[pivotRow];
      m[pivotRow] = swap;
    }

    const pivot = m[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / pivot;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n];
    for (let j = row + 1; j < n; j++) sum -= m[row][j] * x[j];
    x[row] = sum / m[row][row];
  }

  return x.every(Number.isFinite) ? x : null;
}

/**
 * Least-squares solution of an overdetermined system `A x ~= b` via the normal
 * equations `AtA x = At b`.
 *
 * The normal equations square the condition number, which is why they get a bad
 * reputation versus a QR or SVD approach. It is acceptable here because the
 * systems are tiny and well scaled by construction: the colour-correction fit is
 * 12x4 on values in [0,1], and the homography fit is 8x8 on Hartley-normalised
 * coordinates. Both are far from the conditioning limits where this matters.
 */
export function solveLeastSquares(a: Matrix, b: Vector): Vector | null {
  if (a.length !== b.length) {
    throw new Error('solveLeastSquares() requires one right-hand side entry per row');
  }
  if (a.length < a[0].length) {
    // Underdetermined: infinitely many exact solutions, none of them meaningful
    // for our purposes. Callers should have rejected this earlier.
    return null;
  }
  const at = transpose(a);
  const ata = matMul(at, a);
  const atb = matVec(at, b);
  return solve(ata, atb);
}

/** Root-mean-square residual of `A x - b`, for reporting fit quality. */
export function residualRms(a: Matrix, x: Vector, b: Vector): number {
  const predicted = matVec(a, x);
  let sum = 0;
  for (let i = 0; i < b.length; i++) {
    const error = predicted[i] - b[i];
    sum += error * error;
  }
  return Math.sqrt(sum / b.length);
}

export function invert3x3(m: Matrix): Matrix | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];

  const cofactorA = e * i - f * h;
  const cofactorB = -(d * i - f * g);
  const cofactorC = d * h - e * g;

  const det = a * cofactorA + b * cofactorB + c * cofactorC;
  if (Math.abs(det) < 1e-14) return null;

  const invDet = 1 / det;
  return [
    [cofactorA * invDet, -(b * i - c * h) * invDet, (b * f - c * e) * invDet],
    [cofactorB * invDet, (a * i - c * g) * invDet, -(a * f - c * d) * invDet],
    [cofactorC * invDet, -(a * h - b * g) * invDet, (a * e - b * d) * invDet],
  ];
}
