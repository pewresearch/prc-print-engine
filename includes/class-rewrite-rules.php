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
 * Research-team permalinks do not register a `/print` rewrite endpoint, so
 * `/post-slug/print` 404s. Core `redirect_guess_404_permalink()` then 301s to
 * any post whose slug starts with `print` (for example a chart named
 * `print-books-still-dominate-...`). Path interception must resolve the parent
 * and either serve or 404 — it must not fall through to that guess.
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
		$this->loader->add_filter( 'do_redirect_guess_404_permalink', $this, 'disable_404_guess_on_print_path' );
		$this->loader->add_filter( 'redirect_canonical', $this, 'prevent_print_canonical_redirect', 1, 2 );
	}

	/**
	 * Whether a URL path is a print-engine request (`…/print` or `…/print/`).
	 *
	 * @param string $path URL path (may include a query string).
	 * @return bool
	 */
	public static function path_is_print_request( string $path ): bool {
		$parsed = wp_parse_url( $path, PHP_URL_PATH );
		if ( ! is_string( $parsed ) || '' === $parsed ) {
			$parsed = $path;
		}

		return (bool) preg_match( '#/print/?$#', $parsed );
	}

	/**
	 * Strip `/print` and the current blog path from a print request path.
	 *
	 * @param string $path      Request path.
	 * @param string $home_path Blog path from home_url() (e.g. pewresearch-org).
	 * @return string Parent path without leading/trailing slashes.
	 */
	public static function parent_path_from_print_path( string $path, string $home_path = '' ): string {
		$parsed = wp_parse_url( $path, PHP_URL_PATH );
		if ( ! is_string( $parsed ) || '' === $parsed ) {
			$parsed = $path;
		}

		$parent_path = preg_replace( '#/print/?$#', '', $parsed );
		$parent_path = is_string( $parent_path ) ? trim( $parent_path, '/' ) : '';

		$home_path = trim( $home_path, '/' );
		if ( '' !== $home_path && str_starts_with( $parent_path, $home_path . '/' ) ) {
			$parent_path = substr( $parent_path, strlen( $home_path ) + 1 );
		} elseif ( '' !== $home_path && $parent_path === $home_path ) {
			$parent_path = '';
		}

		return trim( $parent_path, '/' );
	}

	/**
	 * Parse a parent permalink path into WP_Query vars (name + optional date).
	 *
	 * @param string $parent_path Path after stripping /print and the blog prefix.
	 * @return array<string, int|string>|null
	 */
	public static function permalink_query_from_parent_path( string $parent_path ): ?array {
		$parent_path = trim( $parent_path, '/' );
		if ( '' === $parent_path ) {
			return null;
		}

		if ( preg_match( '#^(?:[^/]+/)?([0-9]{4})/([0-9]{1,2})/([0-9]{1,2})/([^/]+)$#', $parent_path, $matches ) ) {
			return array(
				'year'     => (int) $matches[1],
				'monthnum' => (int) $matches[2],
				'day'      => (int) $matches[3],
				'name'     => $matches[4],
			);
		}

		$segments = explode( '/', $parent_path );
		$name     = end( $segments );

		return is_string( $name ) && '' !== $name ? array( 'name' => $name ) : null;
	}

	/**
	 * Maybe intercept request for /print URL.
	 *
	 * @param \WP $wp Current WordPress environment instance.
	 */
	public function maybe_intercept_print_request( $wp ) {
		$request_uri = $this->request_uri();
		$path        = wp_parse_url( $request_uri, PHP_URL_PATH );

		if ( ! is_string( $path ) || ! self::path_is_print_request( $path ) ) {
			return;
		}

		$home_path   = (string) wp_parse_url( home_url(), PHP_URL_PATH );
		$parent_path = self::parent_path_from_print_path( $path, is_string( $home_path ) ? $home_path : '' );

		if ( '' === $parent_path ) {
			$this->send_print_miss_response();
		}

		$post = $this->resolve_print_parent_post( $parent_path );
		if ( ! $post || ! Print_Engine::can_serve_print_for_post( $post ) ) {
			$this->send_print_miss_response();
		}

		if ( ! Print_Access::request_may_access_print( $post ) ) {
			$this->send_print_miss_response();
		}

		// Bind the parent post so later canonical/404 logic cannot retarget `print`.
		$wp->query_vars['p']         = $post->ID;
		$wp->query_vars['post_type'] = $post->post_type;
		$wp->query_vars['name']      = $post->post_name;
		$wp->query_vars['print']     = '1';
		unset( $wp->query_vars['error'], $wp->query_vars['attachment'] );

		Print_Engine::serve( $post );
	}

	/**
	 * Do not 404-guess `/print` onto an unrelated `print-*` post.
	 *
	 * @hook do_redirect_guess_404_permalink
	 *
	 * @param bool $do_redirect Whether to guess.
	 * @return bool
	 */
	public function disable_404_guess_on_print_path( $do_redirect ) {
		if ( self::path_is_print_request( $this->request_uri() ) ) {
			return false;
		}

		return $do_redirect;
	}

	/**
	 * Do not canonical-redirect away from `/print`.
	 *
	 * @hook redirect_canonical
	 *
	 * @param string|false $redirect_url  Redirect URL, or false to cancel.
	 * @param string       $requested_url Requested URL.
	 * @return string|false
	 */
	public function prevent_print_canonical_redirect( $redirect_url, $requested_url ) {
		if ( is_string( $requested_url ) && self::path_is_print_request( $requested_url ) ) {
			return false;
		}

		return $redirect_url;
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

	/**
	 * Resolve the post that owns a /print request.
	 *
	 * @param string $parent_path Permalink path without /print.
	 * @return \WP_Post|null
	 */
	private function resolve_print_parent_post( string $parent_path ): ?\WP_Post {
		$post_id = $this->post_id_from_url( home_url( '/' . $parent_path . '/' ) );
		if ( ! $post_id ) {
			$post_id = $this->post_id_from_url( home_url( '/' . $parent_path ) );
		}
		if ( ! $post_id ) {
			$post_id = $this->post_id_from_permalink_path( $parent_path );
		}
		if ( ! $post_id ) {
			return null;
		}

		$post = get_post( $post_id );
		return $post instanceof \WP_Post ? $post : null;
	}

	/**
	 * Resolve a URL to a post ID, preferring the VIP cached helper.
	 *
	 * @param string $url Absolute URL.
	 * @return int
	 */
	private function post_id_from_url( string $url ): int {
		if ( function_exists( 'wpcom_vip_url_to_postid' ) ) {
			return (int) wpcom_vip_url_to_postid( $url );
		}

		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.url_to_postid_url_to_postid -- VIP helper used when present.
		return (int) url_to_postid( $url );
	}

	/**
	 * Sanitized request path+query for print matching.
	 *
	 * @return string
	 */
	private function request_uri(): string {
		if ( ! isset( $_SERVER['REQUEST_URI'] ) ) {
			return '';
		}

		$raw = sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) );
		return is_string( $raw ) ? $raw : '';
	}

	/**
	 * Resolve dated / named permalink paths without url_to_postid().
	 *
	 * @param string $parent_path Parent path.
	 * @return int
	 */
	private function post_id_from_permalink_path( string $parent_path ): int {
		$qv = self::permalink_query_from_parent_path( $parent_path );
		if ( ! is_array( $qv ) || empty( $qv['name'] ) ) {
			return 0;
		}

		$args = array(
			'name'                   => sanitize_title( (string) $qv['name'] ),
			'post_type'              => array( 'post', 'page' ),
			'post_status'            => array( 'publish', 'draft', 'private', 'future' ),
			'posts_per_page'         => 1,
			'no_found_rows'          => true,
			'ignore_sticky_posts'    => true,
			'update_post_meta_cache' => false,
			'update_post_term_cache' => false,
			'fields'                 => 'ids',
		);

		if ( ! empty( $qv['year'] ) ) {
			$args['year'] = (int) $qv['year'];
		}
		if ( ! empty( $qv['monthnum'] ) ) {
			$args['monthnum'] = (int) $qv['monthnum'];
		}
		if ( ! empty( $qv['day'] ) ) {
			$args['day'] = (int) $qv['day'];
		}

		$query = new \WP_Query( $args );
		if ( empty( $query->posts ) ) {
			return 0;
		}

		return (int) $query->posts[0];
	}

	/**
	 * 404 a /print miss without letting core guess another permalink.
	 *
	 * @return never
	 */
	private function send_print_miss_response(): void {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		nocache_headers();
		status_header( 404 );
		exit;
	}
}
