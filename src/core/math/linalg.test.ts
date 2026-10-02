import { describe, expect, it } from 'vitest';
import {
  identity,
  invert3x3,
  matMul,
  matVec,
  residualRms,
  solve,
  solveLeastSquares,
  transpose,
} from './linalg';

describe('solve', () => {
  it('solves a small system exactly', () => {
    const a = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const b = [8, -11, -3];
    const x = solve(a, b);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2, 10);
    expect(x![1]).toBeCloseTo(3, 10);
    expect(x![2]).toBeCloseTo(-1, 10);
  });

  it('handles a system that requires row pivoting', () => {
    // A zero in the leading pivot position forces a swap; without partial
    // pivoting this divides by zero.
    const a = [
      [0, 2, 1],
      [1, 0, 3],
      [4, 1, 0],
    ];
    const b = [5, 7, 6];
    const x = solve(a, b);
    expect(x).not.toBeNull();
    const check = matVec(a, x!);
    expect(check[0]).toBeCloseTo(5, 8);
    expect(check[1]).toBeCloseTo(7, 8);
    expect(check[2]).toBeCloseTo(6, 8);
  });

  it('returns null for a singular matrix instead of guessing', () => {
    const singular = [
      [1, 2],
      [2, 4],
    ];
    expect(solve(singular, [3, 6])).toBeNull();
  });

  it('recovers the identity solution', () => {
    const x = solve(identity(4), [1, 2, 3, 4]);
    expect(x).toEqual([1, 2, 3, 4]);
  });
});

describe('solveLeastSquares', () => {
  it('fits an exact linear relationship with zero residual', () => {
    // y = 3x + 2, sampled at four points.
    const a = [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ];
    const b = [5, 8, 11, 14];
    const x = solveLeastSquares(a, b);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(3, 8);
    expect(x![1]).toBeCloseTo(2, 8);
    expect(residualRms(a, x!, b)).toBeCloseTo(0, 8);
  });

  it('finds the best compromise for inconsistent data', () => {
    // Points (1, 1.1), (2, 1.9), (3, 3.2) are not collinear, so the fit must
    // leave a non-zero residual. Hand-computed via the normal equations:
    //   mean x = 2, mean y = 31/15, Sxx = 2, Sxy = 2.1
    //   slope = 1.05, intercept = 31/15 - 2.1 = -1/30
    const a = [
      [1, 1],
      [2, 1],
      [3, 1],
    ];
    const b = [1.1, 1.9, 3.2];
    const x = solveLeastSquares(a, b);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1.05, 6);
    expect(x![1]).toBeCloseTo(-1 / 30, 6);
    // Residuals are +1/12, -1/6, +1/12 giving an RMS of sqrt(1/72).
    expect(residualRms(a, x!, b)).toBeCloseTo(Math.sqrt(1 / 72), 6);
  });

  it('returns null when there are fewer observations than unknowns', () => {
    expect(solveLeastSquares([[1, 2, 3]], [1])).toBeNull();
  });
});

describe('matrix utilities', () => {
  it('transposes', () => {
    expect(
      transpose([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it('multiplies', () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const b = [
      [5, 6],
      [7, 8],
    ];
    expect(matMul(a, b)).toEqual([
      [19, 22],
      [43, 50],
    ]);
  });

  it('rejects mismatched dimensions', () => {
    expect(() => matMul([[1, 2, 3]], [[1, 2]])).toThrow();
  });

  it('inverts a 3x3 matrix', () => {
    const m = [
      [1, 2, 3],
      [0, 1, 4],
      [5, 6, 0],
    ];
    const inverse = invert3x3(m);
    expect(inverse).not.toBeNull();
    const product = matMul(m, inverse!);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(product[i][j]).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });

  it('returns null when inverting a singular 3x3 matrix', () => {
    expect(
      invert3x3([
        [1, 2, 3],
        [2, 4, 6],
        [1, 1, 1],
      ]),
    ).toBeNull();
  });
});
