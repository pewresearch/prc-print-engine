<?php
/**
 * REST API for print-engine PDF generation and element screenshots.
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Registers REST routes under prc-print-engine/v1.
 */
class Rest_Api {

	public const NAMESPACE = 'prc-print-engine/v1';

	/**
	 * PDF export helper.
	 *
	 * @var Pdf_Export
	 */
	private $pdf_export;

	/**
	 * Register hooks.
	 *
	 * @param Loader     $loader     Hook loader.
	 * @param Pdf_Export $pdf_export PDF export service.
	 */
	public function __construct( $loader, Pdf_Export $pdf_export ) {
		$this->pdf_export = $pdf_export;
		$loader->add_action( 'rest_api_init', $this, 'register_routes' );
	}

	/**
	 * Register REST routes.
	 *
	 * @hook rest_api_init
	 */
	public function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			'/posts/(?P<id>\d+)/generate-pdf',
			array(
				'methods'             => \WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'handle_generate_pdf' ),
				'permission_callback' => array( $this, 'can_edit_post' ),
				'args'                => array(
					'id' => array(
						'required'          => true,
						'type'              => 'integer',
						'sanitize_callback' => 'absint',
					),
				),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/posts/(?P<id>\d+)/pdf',
			array(
				'methods'             => \WP_REST_Server::READABLE,
				'callback'            => array( $this, 'handle_get_pdf_status' ),
				'permission_callback' => array( $this, 'can_edit_post' ),
				'args'                => array(
					'id' => array(
						'required'          => true,
						'type'              => 'integer',
						'sanitize_callback' => 'absint',
					),
				),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/screenshot',
			array(
				'methods'             => \WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'handle_screenshot' ),
				'permission_callback' => array( $this, 'can_request_screenshot' ),
				'args'                => array(
					'url'            => array(
						'required'          => true,
						'type'              => 'string',
						'sanitize_callback' => 'esc_url_raw',
					),
					'selector'       => array(
						'required'          => true,
						'type'              => 'string',
						'sanitize_callback' => 'sanitize_text_field',
					),
					'waitMs'         => array(
						'required'          => false,
						'type'              => 'integer',
						'sanitize_callback' => 'absint',
						'default'           => 10000,
					),
					'attachToPostId' => array(
						'required'          => false,
						'type'              => 'integer',
						'sanitize_callback' => 'absint',
					),
				),
			)
		);
	}

	/**
	 * Permission: current user can edit the target post.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return bool
	 */
	public function can_edit_post( \WP_REST_Request $request ): bool {
		$post_id = (int) $request->get_param( 'id' );
		return $post_id > 0 && current_user_can( 'edit_post', $post_id );
	}

	/**
	 * Permission: screenshots need `edit_posts`; attaching the PNG also needs
	 * `upload_files` and `edit_post` on attachToPostId.
	 *
	 * Runs before the handler so a denied attach never bills a Firebase render.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return bool|\WP_Error
	 */
	public function can_request_screenshot( \WP_REST_Request $request ) {
		if ( ! current_user_can( 'edit_posts' ) ) {
			return false;
		}

		$attach = (int) $request->get_param( 'attachToPostId' );
		if ( $attach > 0 && ( ! current_user_can( 'upload_files' ) || ! current_user_can( 'edit_post', $attach ) ) ) {
			return new \WP_Error(
				'rest_forbidden',
				__( 'You cannot attach a screenshot to this post.', 'prc-print-engine' ),
				array( 'status' => rest_authorization_required_code() )
			);
		}

		return true;
	}

	/**
	 * Hosts the screenshot endpoint may send to the render service.
	 *
	 * Defaults to this site, the network main site, the assets CDN, and the
	 * alpha, beta, and canary environments.
	 *
	 * @return string[] Lowercase host names.
	 */
	public static function get_screenshot_allowed_hosts(): array {
		$hosts = array(
			wp_parse_url( home_url(), PHP_URL_HOST ),
			wp_parse_url( site_url(), PHP_URL_HOST ),
			wp_parse_url( network_home_url(), PHP_URL_HOST ),
		);

		// phpcs:ignore Squiz.Commenting.InlineComment.InvalidEndChar
		$root_domain = 'pewresearch.org'; // pragma: allowlist secret
		foreach ( array( 'assets', 'alpha', 'beta', 'canary' ) as $subdomain ) {
			$hosts[] = $subdomain . '.' . $root_domain;
		}

		/**
		 * Filters the hosts the print-engine screenshot endpoint may render.
		 *
		 * @param string[] $hosts Host names.
		 */
		$hosts = (array) apply_filters( 'prc_print_engine_screenshot_allowed_hosts', $hosts );

		return array_values(
			array_unique(
				array_map( 'strtolower', array_filter( $hosts, 'is_string' ) )
			)
		);
	}

	/**
	 * Whether a URL may be sent to the screenshot render service.
	 *
	 * Requires https, no credentials, the default port, and an allowlisted host.
	 *
	 * @param string $url Absolute URL.
	 * @return bool
	 */
	public static function is_allowed_screenshot_url( string $url ): bool {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return false;
		}

		if ( 'https' !== strtolower( $parts['scheme'] ?? '' ) ) {
			return false;
		}

		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return false;
		}

		if ( isset( $parts['port'] ) && 443 !== (int) $parts['port'] ) {
			return false;
		}

		return in_array( strtolower( $parts['host'] ), self::get_screenshot_allowed_hosts(), true );
	}

	/**
	 * Force-schedule PDF generation.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function handle_generate_pdf( \WP_REST_Request $request ) {
		$post_id = (int) $request->get_param( 'id' );
		$post    = get_post( $post_id );

		if ( ! $post ) {
			return new \WP_Error( 'not_found', __( 'Post not found.', 'prc-print-engine' ), array( 'status' => 404 ) );
		}

		$owner = Pdf_Export::resolve_pdf_owner_post( $post );
		if ( ! $owner ) {
			return new \WP_Error( 'not_found', __( 'Post not found.', 'prc-print-engine' ), array( 'status' => 404 ) );
		}

		if ( ! current_user_can( 'edit_post', (int) $owner->ID ) ) {
			return new \WP_Error(
				'forbidden',
				__( 'You cannot generate a PDF for this post.', 'prc-print-engine' ),
				array( 'status' => 403 )
			);
		}

		if ( ! $this->pdf_export->can_generate_for_post( $owner ) ) {
			return new \WP_Error(
				'ineligible',
				__( 'PDF generation is only available for published, public posts that support the print engine.', 'prc-print-engine' ),
				array( 'status' => 400 )
			);
		}

		if ( ! Pdf_Export::is_configured() ) {
			return new \WP_Error(
				'service_not_configured',
				__( 'PDF render service is not configured.', 'prc-print-engine' ),
				array( 'status' => 503 )
			);
		}

		if ( ! function_exists( 'as_enqueue_async_action' ) ) {
			return new \WP_Error(
				'action_scheduler_unavailable',
				__( 'Action Scheduler is not available.', 'prc-print-engine' ),
				array( 'status' => 503 )
			);
		}

		$owner_id  = (int) $owner->ID;
		$scheduled = $this->pdf_export->force_schedule( $owner_id );

		return new \WP_REST_Response(
			array_merge(
				array(
					'scheduled' => $scheduled,
					'postId'    => $owner_id,
				),
				Pdf_Export::get_status( $owner_id )
			),
			200
		);
	}

	/**
	 * Return current stored PDF status.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function handle_get_pdf_status( \WP_REST_Request $request ) {
		$post_id = (int) $request->get_param( 'id' );
		$post    = get_post( $post_id );
		if ( ! $post ) {
			return new \WP_Error( 'not_found', __( 'Post not found.', 'prc-print-engine' ), array( 'status' => 404 ) );
		}

		$owner = Pdf_Export::resolve_pdf_owner_post( $post );
		if ( ! $owner ) {
			return new \WP_Error( 'not_found', __( 'Post not found.', 'prc-print-engine' ), array( 'status' => 404 ) );
		}

		if ( ! current_user_can( 'edit_post', (int) $owner->ID ) ) {
			return new \WP_Error(
				'forbidden',
				__( 'You cannot view the PDF status for this post.', 'prc-print-engine' ),
				array( 'status' => 403 )
			);
		}

		return new \WP_REST_Response( Pdf_Export::get_status( (int) $owner->ID ), 200 );
	}

	/**
	 * Proxy an element screenshot request to Firebase.
	 *
	 * @param \WP_REST_Request $request Request.
	 * @return \WP_REST_Response|\WP_Error
	 */
	public function handle_screenshot( \WP_REST_Request $request ) {
		$url      = (string) $request->get_param( 'url' );
		$selector = (string) $request->get_param( 'selector' );
		$wait_ms  = (int) $request->get_param( 'waitMs' );
		$attach   = (int) $request->get_param( 'attachToPostId' );

		if ( '' === $url || '' === $selector ) {
			return new \WP_Error(
				'invalid_params',
				__( 'url and selector are required.', 'prc-print-engine' ),
				array( 'status' => 400 )
			);
		}

		if ( ! self::is_allowed_screenshot_url( $url ) ) {
			return new \WP_Error(
				'url_not_allowed',
				__( 'url must be an https URL on this site or the assets CDN.', 'prc-print-engine' ),
				array( 'status' => 400 )
			);
		}

		$png = $this->pdf_export->request_screenshot_bytes( $url, $selector, $wait_ms );
		if ( is_wp_error( $png ) ) {
			return $png;
		}

		$payload = array(
			'pngBase64' => base64_encode( $png ), // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
			'mimeType'  => 'image/png',
		);

		if ( $attach > 0 ) {
			$tmp_file = wp_tempnam( "print-engine-shot-{$attach}.png" );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			file_put_contents( $tmp_file, $png );

			$file_array = array(
				'name'     => sprintf( 'screenshot-%d-%d.png', $attach, time() ),
				'tmp_name' => $tmp_file,
				'type'     => 'image/png',
				'error'    => 0,
				'size'     => filesize( $tmp_file ),
			);

			$attachment_id = media_handle_sideload( $file_array, $attach );
			@unlink( $tmp_file ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged

			if ( is_wp_error( $attachment_id ) ) {
				return $attachment_id;
			}

			$payload['attachmentId'] = (int) $attachment_id;
			$payload['url']          = wp_get_attachment_url( $attachment_id );
		}

		return new \WP_REST_Response( $payload, 200 );
	}
}
