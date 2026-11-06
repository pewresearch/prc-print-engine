<?php
/**
 * Audience policy for print-engine beta surfaces.
 *
 * Content eligibility remains Print_Engine::can_serve_print_for_post().
 * This type answers only: may this request or viewer use /print or see print UI?
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Sealed audience + machine-fetch policy for /print.
 *
 * Invariants:
 * - Browser access requires a WP authenticated session (is_user_logged_in).
 * - Machine access requires a signed-fetch ticket minted for the same post_id with the `print` purpose.
 * - Tickets are only minted by trusted server code (PDF_Export); never from UI.
 */
final class Print_Access {

	/**
	 * Signed-fetch purpose for print-engine machine fetches.
	 *
	 * @var string
	 */
	public const SIGNED_FETCH_PURPOSE = 'print';

	/**
	 * Whether the current WP user may see print beta UI (materials, discovery).
	 *
	 * @return bool
	 */
	public static function audience_may_see_print_ui(): bool {
		return (bool) is_user_logged_in();
	}

	/**
	 * Whether the current HTTP request may be served the print document for $post.
	 *
	 * True when either a logged-in WP user is present, or a valid signed-fetch
	 * ticket for $post->ID is present on the request.
	 *
	 * Does not re-check publish/password/caps — caller already ran can_serve_print_for_post.
	 *
	 * @param \WP_Post $post Resolved print post.
	 * @return bool
	 */
	public static function request_may_access_print( \WP_Post $post ): bool {
		if ( is_user_logged_in() ) {
			return true;
		}

		return self::request_has_print_ticket( $post );
	}

	/**
	 * Whether the current HTTP request carries a valid print ticket for $post.
	 *
	 * Ignores the logged-in session, so a browser visit never counts as a machine fetch.
	 *
	 * @param \WP_Post $post Resolved print post.
	 * @return bool
	 */
	public static function request_has_print_ticket( \WP_Post $post ): bool {
		return \PRC\Primitives\Signed_Fetch\request_authorizes( (int) $post->ID, self::SIGNED_FETCH_PURPOSE );
	}
}
