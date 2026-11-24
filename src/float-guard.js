/* eslint-env browser */
/**
 * Paged.js handler: move a floated figure to the next page instead of losing it.
 *
 * Paged.js never breaks before a float (layout.js findOverflow skips floats)
 * and only checks vertical overflow. A right-floated chart that runs past the
 * page bottom, or that Chrome moves into the next CSS column because it does
 * not fit below its lead, stays outside the clipped page box and vanishes from
 * the PDF. When that happens, the guard picks a new break.
 *
 * When an intro (lead) and its chart do not fit and body content sits above
 * the intro, page-fill.js picks, in order: move both to the next page (only if
 * this page stays half full), shrink the chart up to MAX_FIT_SHRINK, or delay
 * the chart past up to MAX_CHART_DELAY of the following text in its section.
 * A delay needs another pagination pass: the guard records it and view.js
 * moves the figure in the source, then paginates again.
 *
 * A tall chart that is already first on its page (often right under a section
 * or chapter heading) cannot move. It shrinks up to MAX_FIT_SHRINK to fit
 * below that heading; past that it is delayed like a chart beside its intro,
 * or unfloated at full size when there is no intro to keep.
 *
 * Every final break goes through the box guard, so a break never leaves an
 * empty piece of a shaded box behind.
 *
 * Measurements use each piece's own client rects: Paged.js pages are CSS
 * columns, and a pushed-aside float (or its parent) spans two columns, so a
 * single getBoundingClientRect() mixes both.
 */

/**
 * External Dependencies
 */
import { Handler, registerHandlers } from 'pagedjs';

/**
 * Internal Dependencies
 */
import { adjustBreakForBoxes, boxOpenedBy } from './box-guard';
import {
	DELAYED_ATTR,
	FILL_USED_ATTR,
	HOISTED_ATTR,
	REVERTED_ATTR,
	STUCK_BREAK_ATTR,
} from './chart-delay';
import {
	firstNonHeadingChild,
	fitsOnePageHoisted,
	hoistTarget,
	isStackedCompanion,
} from './chart-hoist';
import { isPrintChartFigure } from './chart-reflow';
import {
	figureContentHeight,
	figureOnPage,
	figureParts,
} from './figure-measure';
import {
	decideChartPlacement,
	decideStuckChart,
	SHRINK_SLACK_PX,
	stuckFallbackScale,
} from './page-fill';
import {
	hasDecision,
	recordDecision,
	requestDelay,
	requestFloat,
	requestHoist,
} from './page-fill-log';
import {
	contentBottomBefore,
	filledBefore,
	hasBodyContentBefore,
	hasBodyContentBetween,
	outerHeight,
	rangeFromNode,
	TOLERANCE_PX,
} from './page-measure';

const UNFLOATED_CLASS = 'print-engine-figure--unfloated';
const LEAD_CLASS = 'print-engine-chart-unit__lead';

class FloatOverflowGuard extends Handler {
	/**
	 * @param {Range|undefined} overflow Overflow range Paged.js found.
	 * @param {Element}         rendered Page content wrapper.
	 * @param {DOMRect}         bounds   Page content area.
	 * @param {Object}          layout   Paged.js Layout for this page.
	 * @return {Range|null|undefined} New overflow, null for none, or undefined to keep.
	 */
	onOverflow(overflow, rendered, bounds, layout) {
		const clip =
			findStackedChartBreak(rendered, overflow, bounds) ||
			findClippedFloat(rendered, overflow, bounds);
		let range = overflow;
		if (clip?.breakBefore) {
			range = rangeFromNode(clip.breakBefore, rendered);
		} else if (clip?.stuck) {
			const fix = placeStuckChart(clip.stuck, rendered, bounds);
			range = fix.breakBefore
				? rangeFromNode(fix.breakBefore, rendered)
				: layout.findOverflow(rendered, bounds) || null;
		} else if (clip?.reflow) {
			range = layout.findOverflow(rendered, bounds) || null;
		}
		const adjusted = adjustBreakForBoxes(range, rendered, bounds);
		if (!clip && adjusted === overflow) {
			return undefined;
		}
		return adjusted;
	}
}

/**
 * Scale a figure's image (rendered clone only, so the inline style does not
 * hit Paged.js's undisplayed filter, which runs on the source).
 *
 * @param {Element} figure Figure node.
 * @param {number}  scale  Image scale, 0–1.
 */
function scaleFigure(figure, scale) {
	const img = figure.querySelector('img');
	const imgRect = img.getBoundingClientRect();
	const otherHeight = figureParts(figure).others.reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const imgWidth = Math.floor(imgRect.width * scale);
	figure.setAttribute('data-print-shrunk', String(imgWidth));
	// The 7.5in box cap would hide the caption and note from layout.
	figure.style.setProperty('max-height', 'none', 'important');
	if (!otherHeight) {
		figure.style.setProperty('width', `${imgWidth}px`, 'important');
		figure.style.setProperty('max-width', `${imgWidth}px`, 'important');
	}
	// Set both sides: with max-height already binding, a width-only change
	// would neither shorten the image nor keep its aspect ratio.
	img.style.setProperty('width', `${imgWidth}px`, 'important');
	img.style.setProperty(
		'height',
		`${Math.floor(imgRect.height * scale)}px`,
		'important'
	);
}

/**
 * Image scale at which a figure fits below the content before it.
 *
 * @param {Element} figure   Floated figure.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {number} Scale; 1 or more means it fits as is.
 */
function fitScaleFor(figure, rendered, bounds) {
	const img = figure.querySelector('img');
	if (!img) {
		return 0;
	}
	const style = getComputedStyle(figure);
	const available =
		bounds.bottom -
		contentBottomBefore(figure, rendered, bounds) -
		parseFloat(style.marginTop || '0') -
		parseFloat(style.marginBottom || '0') -
		SHRINK_SLACK_PX;
	const otherHeight = figureParts(figure).others.reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const height = img.getBoundingClientRect().height;
	return height > 0 ? (available - otherHeight) / height : 0;
}

/**
 * Place a float that is first on its page (only headings above it).
 *
 * page-fill.js caps the shrink at MAX_FIT_SHRINK, as for a chart beside its
 * intro. Past that, the chart is delayed: its intro (or, without one, the
 * block just above it, such as a chapter title) and up to MAX_CHART_DELAY of
 * the following text stay on this page and the next pass opens the next page
 * with the chart. A chart that cannot be delayed (no intro, an undone delay,
 * or no copy that fits above it) is unfloated at no more than a 7% shrink,
 * never at full size. If it still does not fit, the page breaks before the
 * whole chart. chart-delay.js may instead ask the next pass to break
 * before the chart (STUCK_BREAK_ATTR) when the page above stays half full or
 * ends a section.
 *
 * @param {Element} figure   Floated figure that cannot move.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {{breakBefore?: Element, reflow?: boolean}} Fix.
 */
function placeStuckChart(figure, rendered, bounds) {
	if (
		figure.hasAttribute(STUCK_BREAK_ATTR) &&
		contentBottomBefore(figure, rendered, bounds) >
			bounds.top + TOLERANCE_PX
	) {
		return { breakBefore: figure };
	}
	const lead = leadFor(figure) || headingAbove(figure);
	const hoist = hoistTarget(figure, rendered, bounds);
	if (hoist) {
		requestHoist(
			figure,
			hoist.before,
			`hoist:${Math.round(hoist.distance)}px`
		);
		unfloatWhole(figure);
		return { reflow: true };
	}
	const isChart = isPrintChartFigure(figure);
	const img = figure.querySelector('img');
	const fitScale =
		!img || figure.hasAttribute('data-print-shrunk')
			? 0
			: Math.min(fitScaleFor(figure, rendered, bounds), 1);
	const decision = decideStuckChart({
		isChart,
		fitScale,
		canDelay: Boolean(lead) && !figure.hasAttribute(REVERTED_ATTR),
	});

	if ('shrink' === decision.action) {
		scaleFigure(figure, decision.scale);
		// At full size the chart only needed its page-top margin dropped;
		// keep the label of the page that broke before it.
		if (decision.scale < 1 || !hasDecision(figure)) {
			recordDecision(figure, `stuck:shrink:${decision.scale.toFixed(3)}`);
		}
		if (!figureOnPage(figure, bounds)) {
			// Keep the scaled size: at full size the heading plus chart would
			// not fit and Paged.js would split the heading across pages.
			unfloatWhole(figure);
		}
		return { reflow: true };
	}

	// Delay or fallback: this pass keeps the chart unfloated at the largest
	// allowed shrink, which is also the final layout if no delay applies.
	const scale = stuckFallbackScale(fitScale);
	if (isChart && img && !figure.hasAttribute('data-print-shrunk')) {
		scaleFigure(figure, scale);
	}
	unfloatWhole(figure);
	if ('delay' === decision.action) {
		requestDelay(figure, lead, { stuck: true });
	} else {
		requestFillOnlyDelay(figure, lead, { stuck: true });
	}
	// Still too tall at the largest allowed shrink: Paged.js would split the
	// heading above line by line or leave the caption behind. Break before
	// the whole chart instead, even though the page above stays short.
	if (
		!figureOnPage(figure, bounds) &&
		contentBottomBefore(figure, rendered, bounds) >
			bounds.top + TOLERANCE_PX
	) {
		recordDecision(figure, 'stuck:break-before:no-fit');
		return { breakBefore: figure };
	}
	// The label if no delay applies; a delay the next pass makes relabels it.
	recordDecision(figure, `stuck:unfloat:${scale.toFixed(3)}`);
	return { reflow: true };
}

/**
 * Unfloat a figure (kept right-aligned) and keep it in one piece. Chart
 * Builder figures carry an inline `break-inside: auto`; an unfloated chart
 * that does not fit must move whole rather than leave its caption behind.
 * Rendered clone only, so the inline style does not reach the source.
 *
 * @param {Element} figure Figure node.
 */
function unfloatWhole(figure) {
	figure.classList.add(UNFLOATED_CLASS);
	figure.style.setProperty('break-inside', 'avoid', 'important');
}

/**
 * Ask for the one fill delay a chart whose delay was undone may take. The
 * pass keeps its current layout; chart-delay.js applies the delay only if
 * it fills the intro's page to MIN_PAGE_FILL.
 *
 * @param {Element} figure    Chart figure.
 * @param {Element} lead      Its intro, or the block above it.
 * @param {Object}  [options] requestDelay() options.
 */
function requestFillOnlyDelay(figure, lead, options = {}) {
	if (
		lead &&
		figure.hasAttribute(REVERTED_ATTR) &&
		!figure.hasAttribute(FILL_USED_ATTR)
	) {
		requestDelay(figure, lead, { ...options, fillOnly: true });
	}
}

/**
 * Apply the page-fill decision for an intro and a chart that do not fit.
 *
 * @param {Element} figure   Floated chart that is clipped or pushed aside.
 * @param {Element} lead     Its intro, with body content above it.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {{breakBefore?: Element, reflow?: boolean}} Fix.
 */
function placeLeadAndChart(figure, lead, rendered, bounds) {
	const groupStart = boxOpenedBy(lead);
	const hoist = hoistTarget(figure, rendered, bounds);
	const intro = firstNonHeadingChild(lead);
	const decision = decideChartPlacement({
		pageHeight: bounds.height,
		canHoist: Boolean(hoist),
		groupFitsHoisted:
			Boolean(intro) &&
			!figure.hasAttribute(HOISTED_ATTR) &&
			fitsOnePageHoisted(lead, figure, bounds),
		filledBeforeGroup: filledBefore(groupStart, rendered, bounds),
		groupFitsOnePage: fitsOnePage(lead, figure, bounds),
		canBreakBeforeGroup: hasBodyContentBefore(rendered, groupStart),
		isChart: isPrintChartFigure(figure),
		fitScale: figure.hasAttribute('data-print-shrunk')
			? 0
			: fitScaleFor(figure, rendered, bounds),
		canDelay: !figure.hasAttribute(REVERTED_ATTR),
	});

	if ('hoist' === decision.action) {
		requestHoist(
			figure,
			hoist.before,
			`hoist:${Math.round(hoist.distance)}px`
		);
		return { breakBefore: figure };
	}
	if ('together' === decision.action) {
		if (decision.hoist) {
			requestHoist(figure, intro, 'together:hoist');
		} else {
			recordDecision(figure, 'together');
		}
		return { breakBefore: groupStart };
	}
	if ('shrink' === decision.action) {
		scaleFigure(figure, decision.scale);
		recordDecision(figure, `shrink:${decision.scale.toFixed(3)}`);
		if (figureOnPage(figure, bounds)) {
			return { reflow: true };
		}
	}
	if ('delay' === decision.action || 'shrink' === decision.action) {
		requestDelay(figure, lead);
		return { breakBefore: figure };
	}
	recordDecision(figure, 'fallback');
	if (fitsOnePage(lead, figure, bounds)) {
		return { breakBefore: groupStart };
	}
	// Only when the intro stays on this page: a fill delay measures the room
	// below it here.
	requestFillOnlyDelay(figure, lead);
	return { breakBefore: figure };
}

/**
 * Fix for the first floated figure that is clipped or pushed off the page.
 *
 * @param {Element}         rendered Page content wrapper.
 * @param {Range|undefined} overflow Current overflow range.
 * @param {DOMRect}         bounds   Page content area.
 * @return {{breakBefore?: Element, stuck?: Element, reflow?: boolean}|null} Fix, or null.
 */
function findClippedFloat(rendered, overflow, bounds) {
	// Overflow from the very top means Paged.js would repeat this page.
	let wholePage;
	const overflowsWholePage = () => {
		if (undefined === wholePage) {
			wholePage = !hasBodyContentBefore(
				rendered,
				overflow.startContainer,
				overflow.startOffset
			);
		}
		return wholePage;
	};
	for (const figure of rendered.querySelectorAll('figure')) {
		const isFloat = getComputedStyle(figure).float !== 'none';
		if (
			!isFloat &&
			isStackedCompanion(figure) &&
			!figureOnPage(figure, bounds) &&
			firstNonHeadingChild(leadFor(figure))
		) {
			requestFloat(figure);
		}
		// A break inside the float (even at offset 0) leaves an empty figure
		// shell here and its heading + intro without the chart; move the
		// whole unit instead.
		const splitsFigure =
			isFloat && overflow && figure.contains(overflow.startContainer);
		if (
			!splitsFigure &&
			overflow &&
			overflow.isPointInRange(figure, 0) &&
			!overflowsWholePage()
		) {
			return null;
		}
		if (!isFloat) {
			continue;
		}
		if (!splitsFigure && figureOnPage(figure, bounds)) {
			continue;
		}
		// A chart an earlier pass delayed opens the next page.
		if (
			figure.hasAttribute(DELAYED_ATTR) &&
			hasBodyContentBefore(rendered, figure)
		) {
			return { breakBefore: breakTargetFor(figure, rendered) };
		}
		const lead = leadFor(figure);
		if (lead && hasBodyContentBefore(rendered, lead)) {
			return placeLeadAndChart(figure, lead, rendered, bounds);
		}
		// Without body content before it, the node is already first on the
		// page (moving it again would loop) or would strand a heading.
		if (hasBodyContentBefore(rendered, figure)) {
			// An intro at the top of the page: the chart may still fit if it
			// moves up beside the intro.
			const hoist = hoistTarget(figure, rendered, bounds);
			if (hoist) {
				requestHoist(
					figure,
					hoist.before,
					`hoist:${Math.round(hoist.distance)}px`
				);
				return { breakBefore: breakTargetFor(figure, rendered) };
			}
			// Or with a shrink of at most MAX_FIT_SHRINK, which is also what
			// an undone delay counts on (shouldRevertDelay()). Past that,
			// delay the chart so the intro keeps the text after it.
			const fitScale = figure.hasAttribute('data-print-shrunk')
				? 0
				: fitScaleFor(figure, rendered, bounds);
			const decision = decideStuckChart({
				isChart: isPrintChartFigure(figure),
				fitScale: Math.min(fitScale, 1),
				canDelay: false,
			});
			if ('shrink' === decision.action && fitScale < 1) {
				scaleFigure(figure, decision.scale);
				if (figureOnPage(figure, bounds)) {
					recordDecision(
						figure,
						`shrink:${decision.scale.toFixed(3)}`
					);
					return { reflow: true };
				}
			}
			if (lead && !figure.hasAttribute(REVERTED_ATTR)) {
				// The in-place fit already failed: shouldRevertDelay() must not
				// undo this delay, but a stale one is still planned again.
				requestDelay(figure, lead, { fitTried: true });
				return { breakBefore: figure };
			}
			requestFillOnlyDelay(figure, lead, { fitTried: true });
			return { breakBefore: breakTargetFor(figure, rendered) };
		}
		if (figureContentHeight(figure) > bounds.height / 2) {
			return { stuck: figure };
		}
	}
	return null;
}

/**
 * Whether the lead and the figure below it fit together on an empty page.
 *
 * @param {Element} lead   Heading + intro wrapper.
 * @param {Element} figure Floated figure.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when both fit in the page height.
 */
function fitsOnePage(lead, figure, bounds) {
	const leadHeight = Array.from(lead.children).reduce(
		(sum, child) => sum + outerHeight(child),
		0
	);
	const style = getComputedStyle(figure);
	return (
		leadHeight +
			figureContentHeight(figure) +
			parseFloat(style.marginTop || '0') +
			parseFloat(style.marginBottom || '0') <=
		bounds.height - TOLERANCE_PX
	);
}

/**
 * Where to break so a chart moves to the next page without leaving the
 * headings right above it behind (no heading ends a page). Headings
 * directly before the chart, and a lead that holds only headings before it,
 * move with it.
 *
 * @param {Element} figure   Chart that moves to the next page.
 * @param {Element} rendered Page content wrapper.
 * @return {Element} Node to break before.
 */
function breakTargetFor(figure, rendered) {
	let target = figure;
	for (;;) {
		const prev = target.previousElementSibling;
		if (prev && /^H[1-6]$/.test(prev.tagName)) {
			target = prev;
			continue;
		}
		if (
			prev &&
			prev.classList.contains(LEAD_CLASS) &&
			!firstNonHeadingChild(prev)
		) {
			target = prev;
			continue;
		}
		// Every earlier child of this lead is a heading: move the whole lead.
		const parent = target.parentElement;
		if (
			!prev &&
			parent?.classList.contains(LEAD_CLASS) &&
			parent !== rendered
		) {
			target = parent;
			continue;
		}
		break;
	}
	return hasBodyContentBefore(rendered, target)
		? boxOpenedBy(target)
		: figure;
}

/**
 * A stacked (in-flow) chart whose intro plus chart are taller than a page:
 * the intro's keep-with-next can never be honored, and Paged.js strands the
 * intro on a page of its own. Delay the chart instead, like a floated one:
 * the intro and up to MAX_CHART_DELAY of following text stay on this page
 * and the next page opens with the chart.
 *
 * @param {Element}         rendered Page content wrapper.
 * @param {Range|undefined} overflow Overflow range Paged.js found.
 * @param {DOMRect}         bounds   Page content area.
 * @return {{breakBefore: Element}|null} Fix, or null.
 */
function findStackedChartBreak(rendered, overflow, bounds) {
	if (!overflow) {
		return null;
	}
	for (const figure of rendered.querySelectorAll('figure')) {
		// A companion-width centered chart floats first (rule 6).
		if (
			!isPrintChartFigure(figure) ||
			getComputedStyle(figure).float !== 'none' ||
			isStackedCompanion(figure) ||
			figure.hasAttribute(DELAYED_ATTR) ||
			figure.hasAttribute(REVERTED_ATTR)
		) {
			continue;
		}
		const lead = leadFor(figure);
		if (!lead || !firstNonHeadingChild(lead)) {
			continue;
		}
		// Only an overflow that starts at the group, or at headings kept
		// with it: one that starts at earlier copy also contains the lead,
		// but must break there.
		const start = overflow.startContainer;
		const atGroup =
			lead.contains(start) ||
			figure.contains(start) ||
			(overflow.comparePoint(lead, 0) >= 0 &&
				!hasBodyContentBetween(rendered, overflow, lead));
		if (!atGroup || fitsOnePage(lead, figure, bounds)) {
			continue;
		}
		if (!hasBodyContentBefore(rendered, lead) && !lead.textContent.trim()) {
			continue;
		}
		requestDelay(figure, lead);
		return { breakBefore: figure };
	}
	return null;
}

/**
 * The tagged block just above a figure that has no lead, such as the chapter
 * title above a chapter's first chart.
 *
 * @param {Element} figure Figure node.
 * @return {Element|null} Block with a data-print-node id, or null.
 */
function headingAbove(figure) {
	let node = figure;
	while (node && !node.previousElementSibling) {
		node = node.parentElement;
	}
	const prev = node?.previousElementSibling;
	return prev?.hasAttribute('data-print-node') ? prev : null;
}

/**
 * Heading + intro wrapper kept with the figure by chart-reflow.
 *
 * @param {Element} figure Figure node.
 * @return {Element|null} Lead element, or null.
 */
function leadFor(figure) {
	const prev = figure.previousElementSibling;
	return prev && prev.classList.contains(LEAD_CLASS) ? prev : null;
}

let registered = false;

/**
 * Register the guard with Paged.js once, before the Previewer runs.
 */
export function registerFloatGuard() {
	if (registered) {
		return;
	}
	registered = true;
	registerHandlers(FloatOverflowGuard);
}
