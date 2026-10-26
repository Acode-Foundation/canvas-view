import {computeFling, splinePosition, splineVelocity, VelocityTracker} from "./spline"

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

function axisPos(f: Axis, t: number) {
	return f.start + f.distance * splinePosition(t / f.duration)
}

/// Velocity in px/s `t` ms into the fling (OverScroller's getCurrVelocity).
function axisVelocity(f: Axis, t: number) {
	return f.distance / f.duration * 1000 * splineVelocity(t / f.duration)
}

/// Touch slop in CSS px (ViewConfiguration's 8dp).
const TOUCH_SLOP = 8
/// Minimum and maximum fling velocity (ViewConfiguration, dp/s).
const MIN_FLING = 50
const MAX_FLING = 8000
/// Android's default long-press timeout.
export const LONG_PRESS_DELAY = 400
/// Repeated flicks add up, like Android's list views (the scroller's
/// flywheel) and Chrome's own touch scrolling (FlingBooster): a touch
/// on a running fling doesn't stop it while the finger keeps moving
/// its way, checked every FLYWHEEL_CHECK ms (AbsListView's
/// FLYWHEEL_TIMEOUT), and flicking again adds the new velocity to the
/// fling's. Without it every flick started from rest.
const FLYWHEEL_CHECK = 40
/// Both the fling and the new flick must be this fast (CSS px/s) to add
/// up (Chrome's kMinBoostFlingSpeed).
const MIN_BOOST = 350
/// Accumulated flings are capped at this multiple of MAX_FLING.
const MAX_BOOST = 3

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
	/// Time of the last momentum step.
	private stepTime = 0
	private flingY: Axis | null = null
	private flingX: Axis | null = null
	/// The current touch landed on a fling that is still running.
	private flywheel = false
	private flywheelTimer: ReturnType<typeof setTimeout> | null = null
	/// Accumulated scroll position at the finger, unclamped, so a drag
	/// past an edge has to come back before the content moves.
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
		this.endFlywheel()
	}

	private endFlywheel() {
		this.flywheel = false
		if (this.flywheelTimer != null) clearTimeout(this.flywheelTimer)
		this.flywheelTimer = null
	}

	/// While a touch rides a fling: stop each axis the finger isn't
	/// pushing along (a finger held still stops the fling within
	/// FLYWHEEL_CHECK ms, as on Android).
	private checkFlywheel = () => {
		this.flywheelTimer = null
		if (!this.flywheel) return
		let now = performance.now()
		let keep = (f: Axis | null, v: number) =>
			f && Math.abs(v) >= MIN_FLING && Math.sign(v) == Math.sign(f.distance) ? f : null
		this.flingY = keep(this.flingY, this.vy.velocity(now))
		this.flingX = keep(this.flingX, this.vx.velocity(now))
		this.syncFinger()
		if (this.flinging) {
			this.flywheelTimer = setTimeout(this.checkFlywheel, FLYWHEEL_CHECK)
		} else {
			this.endFlywheel()
			if (!this.dragging) this.endScroll()
		}
	}

	/// An axis stopped flinging under the finger: the drag carries on
	/// from where it is.
	private syncFinger() {
		if (!this.flingY) this.fingerTop = this.host.scrollTop
		if (!this.flingX) this.fingerLeft = this.host.scrollLeft
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
		this.endFlywheel()
		this.claimed = this.host.claimTouch(e.clientX, e.clientY, e)
		if (this.claimed || !wasFlinging) {
			this.stop()
			if (wasFlinging) this.endScroll()
		} else {
			this.flywheel = true
			this.flywheelTimer = setTimeout(this.checkFlywheel, FLYWHEEL_CHECK)
		}
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
		this.track(e.clientX, e.clientY, e.timeStamp)
	}

	/// Velocity follows the finger itself (like Android's
	/// VelocityTracker), in scroll direction: not the scroll position,
	/// which a riding fling, edges and the slop move differently.
	private track(x: number, y: number, time: number) {
		this.vx.add(time, -x)
		this.vy.add(time, -y)
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
		this.track(x, y, time)
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
		// On a riding fling, the finger's motion moves the fling along
		// (drawn by the next `step`).
		if (!this.lockX) {
			if (this.flingY) {
				this.flingY.start -= dy
			} else {
				this.fingerTop -= dy
				this.host.scrollTop = this.fingerTop
			}
		}
		if (!this.lockY) {
			if (this.flingX) {
				this.flingX.start -= dx
			} else {
				this.fingerLeft -= dx
				this.host.scrollLeft = this.fingerLeft
			}
		}
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
			// A tap on a fling stops it, even before the flywheel check.
			if (this.flinging) {
				this.stop()
				this.endScroll()
			}
			if (!this.stoppedFling) this.host.onTap(e.clientX, e.clientY, e)
			return
		}
		this.dragging = false
		let now = e.timeStamp
		// The drag follows the finger 1:1; speed settings scale the fling.
		let speed = this.host.scrollSpeed
		let clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
		let vy = this.lockX ? 0 : clamp(this.vy.velocity(now) * speed, MAX_FLING * speed)
		let vx = this.lockY ? 0 : clamp(this.vx.velocity(now) * speed, MAX_FLING * speed)
		// Flicking along a fling the finger rode adds to its velocity.
		let t = now - this.flingStart, host = this.host
		let boost = (f: Axis | null, v: number) => {
			if (!f || Math.abs(v) < MIN_BOOST) return v
			let cur = axisVelocity(f, t)
			if (Math.abs(cur) < MIN_BOOST || Math.sign(cur) != Math.sign(v)) return v
			return clamp(v + cur, MAX_FLING * MAX_BOOST * speed)
		}
		if (this.flinging) {
			// Start the new fling where the old one is now (the last frame
			// may be older than the release, or newer).
			let at = Math.max(t, this.stepTime - this.flingStart)
			if (this.flingY) host.scrollTop = axisPos(this.flingY, at)
			if (this.flingX) host.scrollLeft = axisPos(this.flingX, at)
			vy = boost(this.flingY, vy)
			vx = boost(this.flingX, vx)
		}
		this.stop()
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
		this.stop()
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
		this.stepTime = now
		let t = now - this.flingStart
		let host = this.host
		if (this.flingY) {
			let f = this.flingY
			let top = axisPos(f, t)
			host.scrollTop = top
			// Only the edge it moves toward ends it: a fling starting at the
			// top is at 0 on its first frame.
			if (t >= f.duration || (f.distance < 0 ? top <= 0 : top >= host.maxScrollTop)) this.flingY = null
		}
		if (this.flingX) {
			let f = this.flingX
			let left = axisPos(f, t)
			host.scrollLeft = left
			if (t >= f.duration || (f.distance < 0 ? left <= 0 : left >= host.maxScrollLeft)) this.flingX = null
		}
		if (!this.flinging) {
			// A drag riding the fling goes on without it.
			if (this.dragging) this.syncFinger()
			else this.endScroll()
		}
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
		this.endFlywheel()
		if (this.wheelTimer != null) clearTimeout(this.wheelTimer)
		let dom = this.host.surface
		dom.removeEventListener("pointerdown", this.onDown)
		dom.removeEventListener("pointermove", this.onMove)
		dom.removeEventListener("pointerup", this.onUp)
		dom.removeEventListener("pointercancel", this.onCancel)
		dom.removeEventListener("wheel", this.onWheel)
	}
}
