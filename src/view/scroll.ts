import {computeFling, splinePosition, VelocityTracker} from "./spline"

export interface ScrollHost {
	readonly surface: HTMLElement
	readonly dpr: number
	scrollTop: number
	scrollLeft: number
	readonly maxScrollTop: number
	readonly maxScrollLeft: number
	/// Fling velocity and wheel multiplier (1 = Android's own feel).
	readonly scrollSpeed: number
	/// Called whenever the scroll position changed or a frame is needed.
	requestFrame(): void
	/// A tap (no drag) at client coordinates.
	onTap(x: number, y: number, event: PointerEvent): void
	/// Offered every touch first; returning true claims the gesture
	/// (e.g. a selection handle), so moves and the release go to
	/// `gestureMove`/`gestureEnd` instead of scrolling.
	claimTouch(x: number, y: number, event: PointerEvent): boolean
	/// A touch held still for the long-press delay. Returning true
	/// claims the rest of the gesture.
	onLongPress(x: number, y: number): boolean
	gestureMove(x: number, y: number): void
	/// `cancelled`: the gesture was taken away (pointercancel).
	gestureEnd(x: number, y: number, cancelled?: boolean): void
	/// Scrolling (drag, fling or wheel) started / settled.
	onScrollStart(): void
	onScrollEnd(): void
	/// Targets (e.g. block widget DOM) whose pointers aren't captured, so
	/// their own clicks work; dragging there still scrolls.
	foreignTarget?(target: EventTarget | null): boolean
	/// Called with the event time of input that moved the view, for
	/// input-latency accounting.
	noteInput(time: number): void
}

interface Axis {
	start: number
	distance: number
	duration: number
}

/// Touch slop in CSS px (ViewConfiguration's 8dp).
const TOUCH_SLOP = 8
/// Minimum and maximum fling velocity (ViewConfiguration, dp/s).
const MIN_FLING = 50
const MAX_FLING = 8000
/// Android's default long-press timeout.
export const LONG_PRESS_DELAY = 400

/// Owns scrolling: the editor never uses native overflow scrolling,
/// so the content is always drawn for the exact position shown and a
/// fling can't outrun rendering.
export class ScrollController {
	private pointerId = -1
	private startX = 0
	private startY = 0
	private lastX = 0
	private lastY = 0
	private dragging = false
	private lockX = false
	private lockY = false
	private stoppedFling = false
	private vx = new VelocityTracker()
	private vy = new VelocityTracker()
	private flingStart = 0
	private flingY: Axis | null = null
	private flingX: Axis | null = null
	/// Accumulated scroll position at the finger, tracked in floating
	/// point so velocity sees the unclamped motion.
	private fingerTop = 0
	private fingerLeft = 0
	/// The host claimed the current gesture.
	private claimed = false
	private longPressTimer: ReturnType<typeof setTimeout> | null = null
	private wheelTimer: ReturnType<typeof setTimeout> | null = null
	private scrolling = false

	constructor(readonly host: ScrollHost) {
		let dom = host.surface
		dom.addEventListener("pointerdown", this.onDown)
		dom.addEventListener("pointermove", this.onMove)
		dom.addEventListener("pointerup", this.onUp)
		dom.addEventListener("pointercancel", this.onCancel)
		dom.addEventListener("wheel", this.onWheel, {passive: false})
	}

	get flinging() { return !!(this.flingX || this.flingY) }

	get active() { return this.dragging || this.flinging }

	stop() {
		this.flingX = this.flingY = null
	}

	/// The position was set from outside (a scrollbar, `scrollTo`):
	/// momentum mustn't carry on from where the fling was.
	cancelFling() {
		if (!this.flinging) return
		this.stop()
		if (!this.dragging) this.endScroll()
	}

	/// The content above moved by `dy` (rows re-measured): move an
	/// ongoing drag or fling along, so it continues smoothly.
	shift(dy: number) {
		if (this.flingY) this.flingY.start += dy
		this.fingerTop += dy
		this.vy.shift(dy)
	}

	private startScroll() {
		if (this.scrolling) return
		this.scrolling = true
		this.host.onScrollStart()
	}

	private endScroll() {
		if (!this.scrolling) return
		this.scrolling = false
		this.host.onScrollEnd()
	}

	private clearLongPress() {
		if (this.longPressTimer != null) clearTimeout(this.longPressTimer)
		this.longPressTimer = null
	}

	private onDown = (e: PointerEvent) => {
		if (e.pointerType == "mouse" || this.pointerId >= 0) return
		this.pointerId = e.pointerId
		this.startX = this.lastX = e.clientX
		this.startY = this.lastY = e.clientY
		if (!this.host.foreignTarget?.(e.target)) this.host.surface.setPointerCapture(e.pointerId)
		let wasFlinging = this.flinging
		this.stop()
		if (wasFlinging) this.endScroll()
		this.claimed = this.host.claimTouch(e.clientX, e.clientY, e)
		if (this.claimed) return
		this.clearLongPress()
		if (!wasFlinging) this.longPressTimer = setTimeout(() => {
			this.longPressTimer = null
			if (this.pointerId >= 0 && !this.dragging && this.host.onLongPress(this.lastX, this.lastY)) this.claimed = true
		}, LONG_PRESS_DELAY)
		this.dragging = false
		this.lockX = this.lockY = false
		this.stoppedFling = wasFlinging
		this.vx.reset()
		this.vy.reset()
		this.fingerTop = this.host.scrollTop
		this.fingerLeft = this.host.scrollLeft
		this.vx.add(e.timeStamp, this.fingerLeft)
		this.vy.add(e.timeStamp, this.fingerTop)
	}

	private onMove = (e: PointerEvent) => {
		if (e.pointerId != this.pointerId) return
		if (this.claimed) {
			e.preventDefault()
			this.host.noteInput(e.timeStamp)
			this.host.gestureMove(e.clientX, e.clientY)
			return
		}
		let events = e.getCoalescedEvents?.() ?? []
		if (!events.length) events = [e]
		for (let ev of events) this.moveTo(ev.clientX, ev.clientY, ev.timeStamp)
		if (this.dragging) {
			e.preventDefault()
			this.host.noteInput(e.timeStamp)
			this.host.requestFrame()
		}
	}

	private moveTo(x: number, y: number, time: number) {
		if (!this.dragging) {
			let dx = x - this.startX, dy = y - this.startY
			if (Math.hypot(dx, dy) < TOUCH_SLOP) return
			this.dragging = true
			this.clearLongPress()
			this.startScroll()
			let canX = this.host.maxScrollLeft > 0
			// Lock to the dominant axis unless the gesture is clearly diagonal.
			if (!canX || Math.abs(dy) > Math.abs(dx) * 1.6) this.lockY = true
			else if (Math.abs(dx) > Math.abs(dy) * 1.6) this.lockX = true
			// Start moving from the slop boundary so there is no jump.
			this.lastX = x
			this.lastY = y
			return
		}
		let dx = x - this.lastX, dy = y - this.lastY
		this.lastX = x
		this.lastY = y
		if (!this.lockX) {
			this.fingerTop -= dy
			this.host.scrollTop = this.fingerTop
		}
		if (!this.lockY) {
			this.fingerLeft -= dx
			this.host.scrollLeft = this.fingerLeft
		}
		this.vx.add(time, this.fingerLeft)
		this.vy.add(time, this.fingerTop)
	}

	private onUp = (e: PointerEvent) => {
		if (e.pointerId != this.pointerId) return
		this.pointerId = -1
		this.clearLongPress()
		if (this.claimed) {
			this.claimed = false
			this.host.gestureEnd(e.clientX, e.clientY)
			return
		}
		if (!this.dragging) {
			if (!this.stoppedFling) this.host.onTap(e.clientX, e.clientY, e)
			return
		}
		this.dragging = false
		let now = e.timeStamp
		// The drag follows the finger 1:1; speed settings scale the fling.
		let speed = this.host.scrollSpeed
		let clamp = (v: number) => Math.max(-MAX_FLING * speed, Math.min(MAX_FLING * speed, v * speed))
		let vy = this.lockX ? 0 : clamp(this.vy.velocity(now))
		let vx = this.lockY ? 0 : clamp(this.vx.velocity(now))
		this.fling(vx, vy, now)
		if (!this.flinging) this.endScroll()
	}

	private onCancel = (e: PointerEvent) => {
		if (e.pointerId != this.pointerId) return
		this.pointerId = -1
		this.clearLongPress()
		if (this.claimed) {
			this.claimed = false
			this.host.gestureEnd(this.lastX, this.lastY, true)
		}
		this.dragging = false
		this.endScroll()
	}

	/// Start a fling with a velocity in CSS px/s.
	fling(vx: number, vy: number, now = performance.now()) {
		let dpr = this.host.dpr
		let axis = (v: number, start: number): Axis | null => {
			if (Math.abs(v) < MIN_FLING) return null
			let f = computeFling(v, dpr)
			return f.duration > 0 ? {start, distance: f.distance, duration: f.duration} : null
		}
		this.flingY = axis(vy, this.host.scrollTop)
		this.flingX = axis(vx, this.host.scrollLeft)
		this.flingStart = now
		if (this.flinging) {
			this.startScroll()
			this.host.requestFrame()
		}
	}

	/// Advance momentum to the frame time. Returns true while animating.
	step(now: number) {
		if (!this.flinging) return false
		let t = now - this.flingStart
		let host = this.host
		if (this.flingY) {
			let f = this.flingY
			let top = f.start + f.distance * splinePosition(t / f.duration)
			host.scrollTop = top
			// Only the edge it moves toward ends it: a fling starting at the
			// top is at 0 on its first frame.
			if (t >= f.duration || (f.distance < 0 ? top <= 0 : top >= host.maxScrollTop)) this.flingY = null
		}
		if (this.flingX) {
			let f = this.flingX
			let left = f.start + f.distance * splinePosition(t / f.duration)
			host.scrollLeft = left
			if (t >= f.duration || (f.distance < 0 ? left <= 0 : left >= host.maxScrollLeft)) this.flingX = null
		}
		if (!this.flinging) this.endScroll()
		return this.flinging
	}

	private onWheel = (e: WheelEvent) => {
		if (e.ctrlKey) return
		e.preventDefault()
		this.stop()
		let unit = (e.deltaMode == 1 ? 20 : e.deltaMode == 2 ? this.host.surface.clientHeight : 1) * this.host.scrollSpeed
		let dx = e.deltaX * unit, dy = e.deltaY * unit
		if (e.shiftKey && !dx) {
			dx = dy
			dy = 0
		}
		this.startScroll()
		this.host.scrollTop += dy
		this.host.scrollLeft += dx
		this.host.noteInput(e.timeStamp)
		this.host.requestFrame()
		if (this.wheelTimer != null) clearTimeout(this.wheelTimer)
		this.wheelTimer = setTimeout(() => {
			this.wheelTimer = null
			this.endScroll()
		}, 150)
	}

	destroy() {
		this.clearLongPress()
		if (this.wheelTimer != null) clearTimeout(this.wheelTimer)
		let dom = this.host.surface
		dom.removeEventListener("pointerdown", this.onDown)
		dom.removeEventListener("pointermove", this.onMove)
		dom.removeEventListener("pointerup", this.onUp)
		dom.removeEventListener("pointercancel", this.onCancel)
		dom.removeEventListener("wheel", this.onWheel)
	}
}
