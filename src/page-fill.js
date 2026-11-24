/**
 * Page-fill settings and the placement decisions the float guard and box
 * guard apply when a keep-together group does not fit on the current page.
 *
 * Keep-together rules (an intro with its chart, a shaded box) are
 * preferences: they are honored only when the page they leave behind is at
 * least MIN_PAGE_FILL full. Pure functions so the rules can be unit tested
 * without a layout engine.
 */

// Share of the text well a page must keep before a keep-together move.
export const MIN_PAGE_FILL = 0.5;
// The most a chart may shrink to fit beside its intro (charts only).
export const MAX_FIT_SHRINK = 0.07;
// The most text, as a share of the page height, that may sit between an
// intro and its chart when the chart moves to the next page.
export const MAX_CHART_DELAY = 1 / 3;
// The least content, in lines, each piece of a split box must keep.
export const MIN_SPLIT_LINES = 3;
// Room left under a scaled chart for rounding in Chrome's column layout.
export const SHRINK_SLACK_PX = 4;

/**
 * Most a chart may move up in its section, in px (the same one-third of a
 * page as a delay).
 *
 * @param {number} pageHeight Text well height in px.
 * @return {number} Height in px.
 */
export function maxChartHoistPx(pageHeight) {
	return pageHeight * MAX_CHART_DELAY;
}

/**
 * Most text, in px, that may sit between an intro and its delayed chart.
 *
 * @param {number} pageHeight Text well height in px.
 * @return {number} Height in px.
 */
export function maxChartDelayPx(pageHeight) {
	return pageHeight * MAX_CHART_DELAY;
}

/**
 * Whether a page keeps enough content to honor a keep-together move.
 *
 * @param {number} filledPx   Content height left on the page in px.
 * @param {number} pageHeight Text well height in px.
 * @return {boolean} True when the page stays at least MIN_PAGE_FILL full.
 */
export function keepsPageFilled(filledPx, pageHeight) {
	return filledPx >= pageHeight * MIN_PAGE_FILL;
}

/**
 * Whether a delayed chart's intro page must fill with the text after the
 * chart: the MAX_CHART_DELAY limit would leave that page under
 * MIN_PAGE_FILL, so the same section's text fills the page and the chart
 * opens the next one.
 *
 * @param {Object} m            Measurements.
 * @param {number} m.filled     Content height above the room on the intro's page in px.
 * @param {number} m.used       Text the MAX_CHART_DELAY limit keeps before the chart in px.
 * @param {number} m.pageHeight Text well height in px.
 * @return {boolean} True to fill the intro's page.
 */
export function needsFillDelay(m) {
	return !keepsPageFilled(m.filled + m.used, m.pageHeight);
}

/**
 * Choose where an intro and its chart go when they do not fit here.
 *
 * Tried in order: move the chart up on this page, move both to the next
 * page (only when this page stays half full and both fit on one page),
 * shrink the chart a little, delay the chart past some of the following
 * text, move both to the next page with the intro wrapping beside the chart,
 * or fall back to today's break.
 *
 * @param {Object}  m                     Measurements.
 * @param {number}  m.pageHeight          Text well height in px.
 * @param {number}  m.filledBeforeGroup   Content height left if the page breaks before the intro (or its box).
 * @param {boolean} m.groupFitsOnePage    Whether intro and chart fit together on an empty page.
 * @param {boolean} m.canBreakBeforeGroup Whether body content precedes the group, so a break makes progress.
 * @param {boolean} m.isChart             Whether the figure is a chart (only charts shrink).
 * @param {number}  m.fitScale            Image scale that fits the chart in place; 1 or more means no shrink needed.
 * @param {boolean} m.canDelay            Whether the chart may open the next page within its section.
 * @param {boolean} [m.canHoist]          Whether the chart fits on this page when moved up in its section.
 * @param {boolean} [m.groupFitsHoisted]  Whether intro and chart fit on one page with the intro wrapping beside the chart.
 * @return {{action: ('hoist'|'together'|'shrink'|'delay'|'fallback'), scale?: number, hoist?: boolean}} Decision.
 */
export function decideChartPlacement(m) {
	const canMoveGroup =
		m.canBreakBeforeGroup &&
		keepsPageFilled(m.filledBeforeGroup, m.pageHeight);
	if (m.canHoist) {
		return { action: 'hoist' };
	}
	if (canMoveGroup && m.groupFitsOnePage) {
		return { action: 'together', hoist: false };
	}
	if (m.isChart && m.fitScale >= 1 - MAX_FIT_SHRINK && m.fitScale < 1) {
		return { action: 'shrink', scale: m.fitScale };
	}
	if (m.canDelay) {
		return { action: 'delay' };
	}
	if (canMoveGroup && m.groupFitsHoisted) {
		return { action: 'together', hoist: true };
	}
	return { action: 'fallback' };
}

/**
 * Choose what to do with a chart that is first on its page (only headings
 * above it) and does not fit below them.
 *
 * @param {Object}  m          Measurements.
 * @param {boolean} m.isChart  Whether the figure is a chart (only charts shrink).
 * @param {number}  m.fitScale Image scale that fits the chart below the headings, at most 1.
 * @param {boolean} m.canDelay Whether the chart has an intro to keep on this page.
 * @return {{action: ('shrink'|'delay'|'fallback'), scale?: number}} Decision.
 */
export function decideStuckChart(m) {
	if (m.isChart && m.fitScale >= 1 - MAX_FIT_SHRINK) {
		return { action: 'shrink', scale: Math.min(m.fitScale, 1) };
	}
	if (m.canDelay) {
		return { action: 'delay' };
	}
	return { action: 'fallback' };
}

/**
 * Image scale for a chart first on its page that cannot be delayed: the
 * scale that fits, but never smaller than 1 − MAX_FIT_SHRINK.
 *
 * @param {number} fitScale Image scale that fits below the headings.
 * @return {number} Scale, from 1 − MAX_FIT_SHRINK to 1.
 */
export function stuckFallbackScale(fitScale) {
	return Math.min(1, Math.max(fitScale || 0, 1 - MAX_FIT_SHRINK));
}

/**
 * Where a chart first on its page goes when no copy can stay above it.
 *
 * Breaking before the chart is a keep-together move for the content above
 * it, so it needs that page to stay half full or to end a section.
 * Otherwise the chart stays, unfloated at no more than a 7% shrink.
 *
 * @param {Object}  m             Measurements.
 * @param {number}  m.filledAbove Content height above the chart in px.
 * @param {number}  m.pageHeight  Text well height in px.
 * @param {boolean} m.endsSection Whether the content above ends a section.
 * @return {('break-before'|'unfloat-scaled')} Decision.
 */
export function decideStuckFallback(m) {
	return m.endsSection || keepsPageFilled(m.filledAbove, m.pageHeight)
		? 'break-before'
		: 'unfloat-scaled';
}

/**
 * Whether to undo a delay: its intro opens a page that stays under half
 * full, and the chart fits under the intro with at most a 7% shrink. Only
 * the image shrinks; the caption and notes keep their height.
 *
 * @param {Object}  m                Measurements.
 * @param {boolean} m.opensPage      Whether the intro is at the top of its page.
 * @param {number}  m.pageFill       Fill of the intro's page, 0–1.
 * @param {number}  m.roomBelowIntro Room below the intro in px.
 * @param {number}  m.chartHeight    Chart content height in px (image and caption).
 * @param {number}  m.imageHeight    Height of the chart image in px.
 * @param {number}  m.chartMargins   Chart top plus bottom margin in px.
 * @return {boolean} True to undo the delay.
 */
export function shouldRevertDelay(m) {
	return (
		m.opensPage &&
		m.pageFill < MIN_PAGE_FILL &&
		m.chartHeight -
			m.imageHeight * MAX_FIT_SHRINK +
			m.chartMargins +
			SHRINK_SLACK_PX <=
			m.roomBelowIntro
	);
}

/**
 * Choose how a break that falls inside a shaded or bordered box is placed.
 *
 * @param {Object}  m                   Measurements.
 * @param {number}  m.pageHeight        Text well height in px.
 * @param {number}  m.filledBeforeBox   Content height left if the page breaks before the box.
 * @param {boolean} m.boxFitsOnePage    Whether the whole box fits on an empty page.
 * @param {boolean} m.canBreakBeforeBox Whether body content precedes the box.
 * @param {number}  m.linesBefore       Lines of box content before the cut (a chart counts as MIN_SPLIT_LINES).
 * @param {number}  m.linesAfter        Lines of box content after the cut.
 * @return {('move-whole'|'split')} Decision.
 */
export function decideBoxBreak(m) {
	if (
		m.canBreakBeforeBox &&
		m.boxFitsOnePage &&
		keepsPageFilled(m.filledBeforeBox, m.pageHeight)
	) {
		return 'move-whole';
	}
	if (m.linesBefore >= MIN_SPLIT_LINES && m.linesAfter >= MIN_SPLIT_LINES) {
		return 'split';
	}
	// A piece with fewer lines (or none, the empty-shell case) before the
	// cut moves with the rest of the box.
	if (m.linesBefore < MIN_SPLIT_LINES && m.canBreakBeforeBox) {
		return 'move-whole';
	}
	return 'split';
}
