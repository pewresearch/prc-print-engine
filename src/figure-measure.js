/* eslint-env browser */
/**
 * Measurements of a chart figure on a Paged.js page: its image and other
 * pieces, their height, and whether all of them sit inside the page.
 *
 * Measurements use each piece's own client rects: Paged.js pages are CSS
 * columns, and a pushed-aside float (or its parent) spans two columns, so a
 * single getBoundingClientRect() mixes both.
 */

/**
 * Internal Dependencies
 */
import { outerHeight, TOLERANCE_PX } from './page-measure';

/**
 * A figure's image and the children that are not the image (or its link).
 *
 * The image is often wrapped in an inline <a>, whose own rects do not
 * describe the block image inside it, so measure the image directly.
 *
 * @param {Element} figure Figure node.
 * @return {{img: Element|null, others: Element[]}} Parts.
 */
export function figureParts(figure) {
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
export function figureContentHeight(figure) {
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
export function figurePieces(figure) {
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
export function figureOnPage(figure, bounds) {
	return figurePieces(figure).every(
		(rect) =>
			rect.left < bounds.right - TOLERANCE_PX &&
			rect.right <= bounds.right + TOLERANCE_PX &&
			rect.bottom <= bounds.bottom + TOLERANCE_PX
	);
}
