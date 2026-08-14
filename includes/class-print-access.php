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
 * - Machine access requires a valid ticket minted for the same post_id, unexpired.
 * - Tickets are only minted by trusted server code (PDF_Export); never from UI.
 * - Query-arg wire format is private to this class; callers pass whole URLs in/out.
 */
final class Print_Access {

	/**
	 * Query arg carrying the HMAC payload.
	 *
	 * @var string
	 */
	public const MACHINE_QUERY_VAR = 'prc_print_machine';

	/**
	 * Unix expiry for the machine ticket.
	 *
	 * @var string
	 */
	public const MACHINE_EXPIRES_QUERY_VAR = 'prc_print_machine_expires';

	/**
	 * Default ticket lifetime for Firebase fetch + render headroom.
	 *
	 * @var int
	 */
	public const DEFAULT_TICKET_TTL_SECONDS = 900;

	/**
	 * Register machine query vars on the print-engine query_vars filter.
	 *
	 * @param string[] $qvars Existing query vars.
	 * @return string[]
	 */
	public static function register_query_vars( array $qvars ): array {
		$qvars[] = self::MACHINE_QUERY_VAR;
		$qvars[] = self::MACHINE_EXPIRES_QUERY_VAR;
		return $qvars;
	}

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
	 * True when either a logged-in WP user is present, or a valid machine-fetch
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

		return self::machine_ticket_is_valid( (int) $post->ID );
	}

	/**
	 * Attach a short-lived machine-fetch ticket to an absolute /print URL.
	 *
	 * Used only by PDF_Export before handing the URL to Firebase generatePdf.
	 * Ticket is bound to $post_id so it cannot authorize a different post's /print.
	 *
	 * @param string $print_url Absolute print URL (may already have preview args).
	 * @param int    $post_id   Owner post ID Firebase will fetch.
	 * @param int    $ttl       Seconds until expiry.
	 * @return string URL with ticket query args.
	 */
	public static function mint_machine_fetch_url( string $print_url, int $post_id, int $ttl = self::DEFAULT_TICKET_TTL_SECONDS ): string {
		$expires = time() + $ttl;
		$sig     = hash_hmac( 'sha256', $post_id . '|' . $expires, self::signing_key() );

		return add_query_arg(
			array(
				self::MACHINE_QUERY_VAR         => $sig,
				self::MACHINE_EXPIRES_QUERY_VAR => $expires,
			),
			$print_url
		);
	}

	/**
	 * Validate machine ticket on the current request for $post_id.
	 *
	 * @param int $post_id Resolved print post.
	 * @return bool
	 */
	private static function machine_ticket_is_valid( int $post_id ): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- signed machine ticket, not a form nonce.
		if ( ! isset( $_GET[ self::MACHINE_QUERY_VAR ], $_GET[ self::MACHINE_EXPIRES_QUERY_VAR ] ) ) {
			return false;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$sig_raw = wp_unslash( $_GET[ self::MACHINE_QUERY_VAR ] );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$expires_raw = wp_unslash( $_GET[ self::MACHINE_EXPIRES_QUERY_VAR ] );

		if ( ! is_string( $sig_raw ) ) {
			return false;
		}

		$sig = sanitize_text_field( $sig_raw );
		if ( '' === $sig ) {
			return false;
		}

		if ( ! is_scalar( $expires_raw ) || ! is_numeric( $expires_raw ) ) {
			return false;
		}

		$expires = (int) $expires_raw;
		if ( $expires < time() ) {
			return false;
		}

		$expected = hash_hmac( 'sha256', $post_id . '|' . $expires, self::signing_key() );

		return hash_equals( $expected, $sig );
	}

	/**
	 * HMAC key material — WP auth salt; filterable for tests.
	 *
	 * @return string
	 */
	private static function signing_key(): string {
		return (string) apply_filters( 'prc_print_engine_machine_fetch_key', wp_salt( 'auth' ) );
	}
}
