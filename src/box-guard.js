/* eslint-env browser */
/**
 * Break placement for shaded and bordered boxes (`.print-engine-box`).
 *
 * A box moves whole when the page it leaves behind stays half full, or when
 * a split would leave fewer than MIN_SPLIT_LINES of it before the cut (an
 * empty shell is the zero-line case). Otherwise it splits where Paged.js or
 * the float guard put the break. print.scss drops padding at the cut edge.
 *
 * Paged.js passes every onOverflow handler the original overflow and keeps
 * the last answer, so this runs inside the float guard on its final range
 * rather than as a separate handler.
 */

/**
 * Internal Dependencies
 */
import { decideBoxBreak, MIN_SPLIT_LINES } from './page-fill';
import { recordDecision } from './page-fill-log';
import {
	filledBefore,
	hasBodyContentBefore,
	rangeFromNode,
	rangeStartElement,
	TOLERANCE_PX,
} from './page-measure';

export const BOX_CLASS = 'print-engine-box';

const CONTENT_ROOTS =
	'.print-engine-chapter__content, .print-engine-article__content';

const BOX_SELECTOR = [
	'.wp-block-group.has-background',
	'.wp-block-group.has-border-color',
	'.wp-block-group[style*="border"]',
	'.wp-block-group.is-style-callout',
].join(', ');

/**
 * Mark shaded and bordered groups as boxes before pagination.
 *
 * @param {DocumentFragment|Element} root Content root.
 */
export function markPrintBoxes(root) {
	root.querySelectorAll(BOX_SELECTOR).forEach((el) => {
		el.classList.add(BOX_CLASS);
	});
}

/**
 * The outermost box that a node opens: the node is the box's first content,
 * so a break before the node would leave an empty box piece behind.
 *
 * @param {Element} node Break target.
 * @return {Element} The box, or the node itself.
 */
export function boxOpenedBy(node) {
	let target = node;
	let box = null;
	for (
		let parent = node.parentElement;
		parent &&
		!parent.matches(CONTENT_ROOTS) &&
		firstContentChild(parent) === target;
		parent = parent.parentElement
	) {
		target = parent;
		if (parent.classList.contains(BOX_CLASS)) {
			box = parent;
		}
	}
	return box || node;
}

/**
 * First child element that is not an empty paragraph.
 *
 * @param {Element} el Parent.
 * @return {Element|null} Child.
 */
function firstContentChild(el) {
	for (const child of el.children) {
		if (child.tagName === 'P' && !(child.textContent || '').trim()) {
			continue;
		}
		return child;
	}
	return null;
}

/**
 * Count lines of content in a range: text lines by column and top, plus
 * MIN_SPLIT_LINES for each image or SVG.
 *
 * @param {Range}   range  Range inside a box.
 * @param {DOMRect} bounds Page content area.
 * @return {number} Line count.
 */
function countLines(range, bounds) {
	const root = range.commonAncestorContainer;
	const scope =
		root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
	const keys = new Set();
	const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
	for (let text = walker.nextNode(); text; text = walker.nextNode()) {
		if (!text.textContent.trim() || !range.intersectsNode(text)) {
			continue;
		}
		const part = document.createRange();
		part.selectNodeContents(text);
		if (text === range.startContainer) {
			part.setStart(text, range.startOffset);
		}
		if (text === range.endContainer) {
			part.setEnd(text, range.endOffset);
		}
		for (const rect of part.getClientRects()) {
			if (rect.width > 0 && rect.height > 0) {
				const column = Math.floor(
					(rect.left - bounds.left) / bounds.width
				);
				keys.add(`${column}:${Math.round(rect.top)}`);
			}
		}
	}
	let media = 0;
	scope.querySelectorAll('img, svg').forEach((el) => {
		if (range.intersectsNode(el) && el.getBoundingClientRect().height > 0) {
			media += 1;
		}
	});
	return keys.size + media * MIN_SPLIT_LINES;
}

/**
 * Total laid-out height of a box across columns.
 *
 * @param {Element} box Box element.
 * @return {number} Height in px.
 */
function boxHeight(box) {
	return Array.from(box.getClientRects()).reduce(
		(sum, rect) => sum + rect.height,
		0
	);
}

/**
 * Move a break that falls inside one or more boxes when the box rules say so.
 *
 * Boxes are checked from the innermost out. When an inner box moves whole,
 * the break now sits before it, and the next box out is checked against
 * that break, so moving an inner box never leaves an empty outer shell.
 *
 * @param {Range|null} range    Break range (Paged.js or float guard).
 * @param {Element}    rendered Page content wrapper.
 * @param {DOMRect}    bounds   Page content area.
 * @return {Range|null} The same range, or one that starts before a box.
 */
export function adjustBreakForBoxes(range, rendered, bounds) {
	if (!range) {
		return range;
	}
	let current = range;
	let box = rangeStartElement(range)?.closest?.(`.${BOX_CLASS}`);
	while (box && rendered.contains(box)) {
		if (rangeStartElement(current) !== box) {
			current = placeBreakInBox(current, box, rendered, bounds);
		}
		box = box.parentElement?.closest(`.${BOX_CLASS}`);
	}
	return current;
}

/**
 * Apply the box rules to a break inside one box.
 *
 * @param {Range}   range    Break range inside the box.
 * @param {Element} box      Box element.
 * @param {Element} rendered Page content wrapper.
 * @param {DOMRect} bounds   Page content area.
 * @return {Range} The same range, or one that starts before the box.
 */
function placeBreakInBox(range, box, rendered, bounds) {
	const before = document.createRange();
	before.setStart(box, 0);
	before.setEnd(range.startContainer, range.startOffset);
	const after = document.createRange();
	after.setStart(range.startContainer, range.startOffset);
	after.setEnd(box, box.childNodes.length);

	const decision = decideBoxBreak({
		pageHeight: bounds.height,
		filledBeforeBox: filledBefore(box, rendered, bounds),
		boxFitsOnePage: boxHeight(box) <= bounds.height - TOLERANCE_PX,
		canBreakBeforeBox: hasBodyContentBefore(rendered, box),
		linesBefore: countLines(before, bounds),
		linesAfter: countLines(after, bounds),
	});
	if (decision === 'move-whole') {
		recordDecision(box, 'box:move-whole');
		return rangeFromNode(box, rendered);
	}
	recordDecision(box, 'box:split');
	return range;
}
