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
import { DELAYED_ATTR, REVERTED_ATTR, STUCK_BREAK_ATTR } from './chart-delay';
import { isPrintChartFigure } from './chart-reflow';
import {
	decideChartPlacement,
	decideStuckChart,
	stuckFallbackScale,
} from './page-fill';
import { recordDecision, requestDelay } from './page-fill-log';
import {
	contentBottomBefore,
	filledBefore,
	hasBodyContentBefore,
	outerHeight,
	rangeFromNode,
	TOLERANCE_PX,
} from './page-measure';

const UNFLOATED_CLASS = 'print-engine-figure--unfloated';
const LEAD_CLASS = 'print-engine-chart-unit__lead';
// Room left under a scaled chart for rounding in Chrome's column layout.
const SHRINK_SLACK_PX = 4;

class FloatOverflowGuard extends Handler {
	/**
	 * @param {Range|undefined} overflow Overflow range Paged.js found.
	 * @param {Element}         rendered Page content wrapper.
	 * @param {DOMRect}         bounds   Page content area.
	 * @param {Object}          layout   Paged.js Layout for this page.
	 * @return {Range|null|undefined} New overflow, null for none, or undefined to keep.
	 */
	onOverflow(overflow, rendered, bounds, layout) {
		const clip = findClippedFloat(rendered, overflow, bounds);
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
 * or no copy that fits above it) is unfloated at no more than a 5% shrink,
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
		recordDecision(figure, `stuck:shrink:${decision.scale.toFixed(3)}`);
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
 * A figure's image and the children that are not the image (or its link).
 *
 * The image is often wrapped in an inline <a>, whose own rects do not
 * describe the block image inside it, so measure the image directly.
 *
 * @param {Element} figure Figure node.
 * @return {{img: Element|null, others: Element[]}} Parts.
 */
function figureParts(figure) {
	const img = figure.querySelector('img');
	const holder = img
		? [...figure.children].find((child) => child.contains(img))
		: null;
	return {
		img,
		others: [...figure.children].filter((child) => child !== holder),
	};
}

/**
 * Height of a figure's content: the image plus its other children.
 *
 * @param {Element} figure Figure node.
 * @return {number} Content height in px.
 */
function figureContentHeight(figure) {
	const { img, others } = figureParts(figure);
	return (
		(img ? img.getBoundingClientRect().height : 0) +
		others.reduce((sum, child) => sum + outerHeight(child), 0)
	);
}

/**
 * Client rects of a figure's pieces (image and other children, one rect per
 * column).
 *
 * @param {Element} figure Figure node.
 * @return {DOMRect[]} Non-empty rects.
 */
function figurePieces(figure) {
	const { img, others } = figureParts(figure);
	const parts = img ? [img, ...others] : [figure];
	return parts
		.flatMap((part) => [...part.getClientRects()])
		.filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * Whether every piece of a figure sits inside the page content area.
 *
 * @param {Element} figure Figure node.
 * @param {DOMRect} bounds Page content area.
 * @return {boolean} True when nothing is clipped or pushed aside.
 */
function figureOnPage(figure, bounds) {
	return figurePieces(figure).every(
		(rect) =>
			rect.left < bounds.right - TOLERANCE_PX &&
			rect.right <= bounds.right + TOLERANCE_PX &&
			rect.bottom <= bounds.bottom + TOLERANCE_PX
	);
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
	const decision = decideChartPlacement({
		pageHeight: bounds.height,
		filledBeforeGroup: filledBefore(groupStart, rendered, bounds),
		groupFitsOnePage: fitsOnePage(lead, figure, bounds),
		canBreakBeforeGroup: hasBodyContentBefore(rendered, groupStart),
		isChart: isPrintChartFigure(figure),
		fitScale: figure.hasAttribute('data-print-shrunk')
			? 0
			: fitScaleFor(figure, rendered, bounds),
		canDelay: !figure.hasAttribute(REVERTED_ATTR),
	});

	if ('together' === decision.action) {
		recordDecision(figure, 'together');
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
	return fitsOnePage(lead, figure, bounds)
		? { breakBefore: groupStart }
		: { breakBefore: figure };
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
			return { breakBefore: figure };
		}
		const lead = leadFor(figure);
		if (lead && hasBodyContentBefore(rendered, lead)) {
			return placeLeadAndChart(figure, lead, rendered, bounds);
		}
		// Without body content before it, the node is already first on the
		// page (moving it again would loop) or would strand a heading.
		if (hasBodyContentBefore(rendered, figure)) {
			return { breakBefore: figure };
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
