import {describe, expect, test} from "bun:test"
import {computeFling, splinePosition, splineVelocity, VelocityTracker} from "../src/view/spline"
import {packRGBA, unpackRGBA} from "../src/core/color"

describe("spline", () => {
	test("position is monotonic from 0 to 1", () => {
		let prev = -1
		for (let t = 0; t <= 1.0001; t += 0.01) {
			let p = splinePosition(t)
			expect(p).toBeGreaterThanOrEqual(prev)
			prev = p
		}
		expect(splinePosition(0)).toBe(0)
		expect(splinePosition(1)).toBe(1)
	})

	test("velocity decays to zero", () => {
		expect(splineVelocity(0.05)).toBeGreaterThan(splineVelocity(0.5))
		expect(splineVelocity(1)).toBe(0)
	})

	test("fling distance grows with velocity and keeps its sign", () => {
		let slow = computeFling(1000, 2.625), fast = computeFling(4000, 2.625)
		expect(fast.distance).toBeGreaterThan(slow.distance)
		expect(fast.duration).toBeGreaterThan(slow.duration)
		expect(computeFling(-4000, 2.625).distance).toBeCloseTo(-fast.distance)
		// Roughly Android-like: a 4000 CSS px/s fling travels a few thousand px in ~1-3s.
		expect(fast.distance).toBeGreaterThan(1000)
		expect(fast.distance).toBeLessThan(8000)
		expect(fast.duration).toBeGreaterThan(800)
		expect(fast.duration).toBeLessThan(4000)
	})
})

describe("VelocityTracker", () => {
	test("measures constant velocity", () => {
		let v = new VelocityTracker()
		for (let i = 0; i <= 10; i++) v.add(i * 8, i * 8 * 2) // 2 px/ms
		expect(v.velocity(80)).toBeCloseTo(2000, -1)
	})

	test("a pause before release means no fling", () => {
		let v = new VelocityTracker()
		for (let i = 0; i <= 10; i++) v.add(i * 8, i * 16)
		expect(v.velocity(80 + 100)).toBe(0)
	})

	test("old samples are dropped after a pause", () => {
		let v = new VelocityTracker()
		for (let i = 0; i <= 5; i++) v.add(i * 8, i * 100)
		v.add(200, 500)
		v.add(208, 504)
		expect(v.velocity(208)).toBeCloseTo(500, -1)
	})
})

describe("color", () => {
	test("pack/unpack round trip", () => {
		expect(unpackRGBA(packRGBA(1, 2, 3, 4))).toEqual([1, 2, 3, 4])
		expect(unpackRGBA(packRGBA(255, 128, 0))).toEqual([255, 128, 0, 255])
	})
})
