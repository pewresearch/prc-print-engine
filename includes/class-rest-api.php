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
	 * @param Loader     $loader     Hook loader.
	 * @param Pdf_Export $pdf_export PDF export service.
	 */
	public function __construct( $loader, Pdf_Export $pdf_export ) {
		$this->pdf_export = $pdf_export;
		$loader->add_action( 'rest_api_init', $this, 'register_routes' );
	}

	/**
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
				'permission_callback' => static function () {
					return current_user_can( 'edit_posts' );
				},
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
		if ( ! get_post( $post_id ) ) {
			return new \WP_Error( 'not_found', __( 'Post not found.', 'prc-print-engine' ), array( 'status' => 404 ) );
		}

		return new \WP_REST_Response( Pdf_Export::get_status( $post_id ), 200 );
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

		$png = $this->pdf_export->request_screenshot_bytes( $url, $selector, $wait_ms );
		if ( is_wp_error( $png ) ) {
			return $png;
		}

		$payload = array(
			'pngBase64' => base64_encode( $png ), // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
			'mimeType'  => 'image/png',
		);

		if ( $attach > 0 ) {
			if ( ! current_user_can( 'edit_post', $attach ) ) {
				return new \WP_Error(
					'forbidden',
					__( 'You cannot attach a screenshot to this post.', 'prc-print-engine' ),
					array( 'status' => 403 )
				);
			}

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
