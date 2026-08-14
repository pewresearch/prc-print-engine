<?php
/**
 * Rewrite rules for the /print URL endpoint.
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Handles /print URL endpoints (e.g. /politics/2025/01/my-article/print).
 *
 * @package PRC\Platform\Print_Engine
 */
class Rewrite_Rules {

	/**
	 * The loader instance.
	 *
	 * @var Loader
	 */
	protected $loader;

	/**
	 * Constructor.
	 *
	 * @param Loader $loader The loader instance.
	 */
	public function __construct( Loader $loader ) {
		$this->loader = $loader;

		$this->loader->add_action( 'parse_request', $this, 'maybe_intercept_print_request', 1 );
		$this->loader->add_action( 'template_redirect', $this, 'maybe_redirect_pdf_query_param', 1 );
	}

	/**
	 * Maybe intercept request for /print URL.
	 *
	 * @param \WP $wp Current WordPress environment instance.
	 */
	public function maybe_intercept_print_request( $wp ) {
		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$path        = wp_parse_url( $request_uri, PHP_URL_PATH );

		if ( ! $path ) {
			return;
		}

		if ( ! preg_match( '#/print/?$#', $path ) ) {
			return;
		}

		$parent_path = preg_replace( '#/print/?$#', '', $path );
		$parent_path = trim( $parent_path, '/' );

		if ( '' === $parent_path ) {
			return;
		}

		// Non-prod VIP paths may include /pewresearch-org.
		$parent_path = str_replace( 'pewresearch-org', '', $parent_path );
		$parent_path = trim( $parent_path, '/' );

		$post_id = url_to_postid( home_url( '/' . $parent_path . '/' ) );

		if ( ! $post_id ) {
			$post_id = url_to_postid( home_url( '/' . $parent_path ) );
		}

		if ( ! $post_id ) {
			return;
		}

		$post = get_post( $post_id );
		if ( ! $post || ! Print_Engine::can_serve_print_for_post( $post ) ) {
			return;
		}

		if ( ! Print_Access::request_may_access_print( $post ) ) {
			return;
		}

		Print_Engine::serve( $post );
	}

	/**
	 * Redirect legacy ?pdf=true to /print when safe; otherwise serve print view.
	 *
	 * @return void
	 */
	public function maybe_redirect_pdf_query_param(): void {
		if ( ! $this->request_wants_pdf_query_param() ) {
			return;
		}

		if ( ! is_singular() ) {
			return;
		}

		global $post;
		if ( ! $post instanceof \WP_Post ) {
			return;
		}

		if ( ! Print_Engine::can_serve_print_for_post( $post ) ) {
			return;
		}

		if ( ! Print_Access::request_may_access_print( $post ) ) {
			return;
		}

		$print_url = Print_Engine::get_print_url( $post );
		if ( $print_url ) {
			// Preserve preview/access query args so the follow-up /print request still authorizes.
			$preserve = array();
			foreach ( array( 'preview', 'preview_nonce', 'preview_id', 'p', 'page_id' ) as $key ) {
				if ( ! isset( $_GET[ $key ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
					continue;
				}
				$raw = wp_unslash( $_GET[ $key ] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
				if ( ! is_string( $raw ) ) {
					continue;
				}
				$preserve[ $key ] = sanitize_text_field( $raw );
			}
			if ( ! empty( $preserve ) ) {
				$print_url = add_query_arg( $preserve, $print_url );
			}
			wp_safe_redirect( $print_url, 302 );
			exit;
		}

		Print_Engine::serve( $post );
	}

	/**
	 * Whether the request asks for print via ?pdf=true (legacy alias).
	 *
	 * @return bool
	 */
	private function request_wants_pdf_query_param(): bool {
		if ( ! isset( $_GET['pdf'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			return false;
		}

		$raw = wp_unslash( $_GET['pdf'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( ! is_string( $raw ) ) {
			return false;
		}

		$val = strtolower( sanitize_text_field( $raw ) );

		return in_array( $val, array( '1', 'true', 'yes', 'on' ), true );
	}
}
