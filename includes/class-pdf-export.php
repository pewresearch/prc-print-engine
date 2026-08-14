<?php
/**
 * Server-side PDF export via Firebase headless Chromium.
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Schedules and runs PDF generation for print-engine posts.
 */
class Pdf_Export {

	public const ACTION_HOOK  = 'prc_print_engine_generate_pdf';
	public const ACTION_GROUP = 'prc-print-engine';

	public const META_ATTACHMENT_ID = '_print_engine_pdf_attachment_id';
	public const META_PDF_URL       = '_print_engine_pdf_url';
	public const META_CONTENT_HASH  = '_print_engine_content_hash';
	public const META_GENERATED_AT  = '_print_engine_pdf_generated_at';

	/**
	 * Register hooks.
	 *
	 * @param Loader $loader Hook loader.
	 */
	public function __construct( $loader ) {
		$loader->add_action( 'prc_platform_async_on_publish', $this, 'maybe_schedule_pdf_generation', 10, 1 );
		$loader->add_action( 'prc_platform_async_on_update', $this, 'maybe_schedule_pdf_generation', 10, 1 );
		$loader->add_action( self::ACTION_HOOK, $this, 'generate_pdf', 10, 2 );
	}

	/**
	 * Resolve Firebase render endpoint URLs.
	 *
	 * @return array<string, string>
	 */
	public static function get_endpoints(): array {
		$endpoints = apply_filters( 'prc_platform_firebase_render_endpoints', array() );
		return is_array( $endpoints ) ? $endpoints : array();
	}

	/**
	 * Whether the generatePdf Cloud Function is configured.
	 *
	 * @return bool
	 */
	public static function is_configured(): bool {
		$endpoints = self::get_endpoints();
		return ! empty( $endpoints['generate_pdf'] ) && class_exists( '\\PRC\\Platform\\Firebase' );
	}

	/**
	 * Whether a generate job is already pending for this post.
	 *
	 * @param int $post_id Post ID.
	 * @return bool
	 */
	public static function is_action_pending( int $post_id ): bool {
		if ( ! function_exists( 'as_get_scheduled_actions' ) ) {
			return false;
		}

		$actions = as_get_scheduled_actions(
			array(
				'hook'                  => self::ACTION_HOOK,
				'args'                  => array( 'post_id' => $post_id ),
				'group'                 => self::ACTION_GROUP,
				'status'                => \ActionScheduler_Store::STATUS_PENDING,
				'partial_args_matching' => 'like',
				'per_page'              => 1,
				'offset'                => 0,
			),
			'ids'
		);

		return ! empty( $actions );
	}

	/**
	 * Compute a content hash used to skip no-op regenerations.
	 *
	 * Includes published chapter bodies for report packages so parent-only
	 * updates cannot skip regen when assembled /print HTML still changed.
	 *
	 * @param \WP_Post $post Post object.
	 * @return string
	 */
	public function compute_content_hash( \WP_Post $post ): string {
		$parts = array(
			(string) $post->ID,
			(string) $post->post_modified_gmt,
			(string) $post->post_content,
		);

		if ( function_exists( 'get_post_meta' ) ) {
			$parts[] = (string) get_post_meta( $post->ID, 'package_parts', true );
			$parts[] = (string) get_post_meta( $post->ID, 'sub_title', true );
			$parts[] = (string) get_post_meta( $post->ID, 'sub_headline', true );
		}

		if ( function_exists( '\PRC\Platform\Report_Package\get_package_chapters' ) ) {
			$chapters = \PRC\Platform\Report_Package\get_package_chapters( $post->ID );
			if ( is_array( $chapters ) ) {
				foreach ( $chapters as $chapter ) {
					$chapter_id = isset( $chapter['id'] ) ? (int) $chapter['id'] : 0;
					if ( ! $chapter_id || $chapter_id === (int) $post->ID ) {
						continue;
					}
					$chapter_post = get_post( $chapter_id );
					if ( ! $chapter_post || 'publish' !== $chapter_post->post_status ) {
						continue;
					}
					$parts[] = (string) $chapter_post->ID;
					$parts[] = (string) $chapter_post->post_modified_gmt;
					$parts[] = (string) $chapter_post->post_content;
				}
			}
		}

		return hash( 'sha256', implode( '|', $parts ) );
	}

	/**
	 * Resolve the post that should own the generated PDF.
	 *
	 * Report chapters regenerate the parent package PDF, not a per-chapter file.
	 *
	 * @param \WP_Post $post Post object.
	 * @return \WP_Post|null
	 */
	public static function resolve_pdf_owner_post( \WP_Post $post ): ?\WP_Post {
		if (
			function_exists( '\PRC\Platform\Report_Package\is_chapter_part_of_report_package' )
			&& function_exists( '\PRC\Platform\Report_Package\get_package_id' )
			&& \PRC\Platform\Report_Package\is_chapter_part_of_report_package( $post->ID )
		) {
			$parent_id = (int) \PRC\Platform\Report_Package\get_package_id( $post->ID );
			if ( $parent_id && $parent_id !== (int) $post->ID ) {
				$parent = get_post( $parent_id );
				return $parent instanceof \WP_Post ? $parent : null;
			}
		}

		return $post;
	}

	/**
	 * Whether the post is eligible for automatic PDF generation.
	 *
	 * @param \WP_Post $post Post object.
	 * @return bool
	 */
	public function can_generate_for_post( \WP_Post $post ): bool {
		if ( 'publish' !== $post->post_status ) {
			return false;
		}

		if ( ! empty( $post->post_password ) ) {
			return false;
		}

		if ( ! post_type_supports( $post->post_type, 'prc-print-engine' ) ) {
			return false;
		}

		if ( ! Print_Engine::can_serve_print_for_post( $post ) ) {
			return false;
		}

		return true;
	}

	/**
	 * Schedule async PDF generation when content changed.
	 *
	 * @param \WP_Post $ref_post Post from the publish pipeline.
	 */
	public function maybe_schedule_pdf_generation( $ref_post ): void {
		if ( ! $ref_post instanceof \WP_Post ) {
			return;
		}

		if ( ! function_exists( 'as_enqueue_async_action' ) ) {
			return;
		}

		if ( ! self::is_configured() ) {
			return;
		}

		$owner = self::resolve_pdf_owner_post( $ref_post );
		if ( ! $owner || ! $this->can_generate_for_post( $owner ) ) {
			return;
		}

		$post_id     = (int) $owner->ID;
		$is_chapter  = (int) $ref_post->ID !== $post_id;

		// Chapter edits always invalidate the parent package PDF.
		if ( $is_chapter ) {
			delete_post_meta( $post_id, self::META_CONTENT_HASH );
		} else {
			$new_hash = $this->compute_content_hash( $owner );
			$stored   = (string) get_post_meta( $post_id, self::META_CONTENT_HASH, true );
			if ( $new_hash === $stored ) {
				return;
			}
		}

		if ( self::is_action_pending( $post_id ) ) {
			return;
		}

		as_enqueue_async_action(
			self::ACTION_HOOK,
			array( 'post_id' => $post_id ),
			self::ACTION_GROUP
		);
	}

	/**
	 * Force-schedule PDF generation (clears hash so the job always runs).
	 *
	 * Resolves report chapters to the parent package owner before enqueueing.
	 *
	 * @param int $post_id Post ID.
	 * @return bool True when a new action was enqueued.
	 */
	public function force_schedule( int $post_id ): bool {
		if ( ! function_exists( 'as_enqueue_async_action' ) ) {
			return false;
		}

		if ( ! self::is_configured() ) {
			return false;
		}

		$post = get_post( $post_id );
		if ( ! $post ) {
			return false;
		}

		$owner = self::resolve_pdf_owner_post( $post );
		if ( ! $owner || ! $this->can_generate_for_post( $owner ) ) {
			return false;
		}

		$post_id = (int) $owner->ID;

		delete_post_meta( $post_id, self::META_CONTENT_HASH );

		if ( self::is_action_pending( $post_id ) ) {
			return false;
		}

		as_enqueue_async_action(
			self::ACTION_HOOK,
			array( 'post_id' => $post_id ),
			self::ACTION_GROUP
		);

		return true;
	}

	/**
	 * Action Scheduler callback: call Firebase generatePdf and sideload the result.
	 *
	 * @param int    $post_id  Post ID.
	 * @param string $base_url Optional public origin override (e.g. https://alpha.pewresearch.org).
	 * @throws \RuntimeException When generation or sideload fails.
	 */
	public function generate_pdf( int $post_id, string $base_url = '' ): void {
		$post = get_post( $post_id );
		if ( ! $post || ! $this->can_generate_for_post( $post ) ) {
			return;
		}

		$print_url = Print_Engine::get_print_url( $post );
		if ( ! $print_url ) {
			throw new \RuntimeException( 'Could not resolve print URL.' );
		}

		if ( ! empty( $base_url ) ) {
			$site_url  = rtrim( site_url(), '/' );
			$print_url = rtrim( $base_url, '/' ) . substr( $print_url, strlen( $site_url ) );
		}

		$print_url = Print_Access::mint_machine_fetch_url( $print_url, (int) $post->ID );

		$pdf_binary = $this->request_pdf_bytes( $print_url );
		if ( is_wp_error( $pdf_binary ) ) {
			throw new \RuntimeException( $pdf_binary->get_error_message() );
		}

		$tmp_file = wp_tempnam( "print-engine-{$post_id}.pdf" );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		file_put_contents( $tmp_file, $pdf_binary );

		$stem       = sanitize_file_name( $post->post_name ? $post->post_name : (string) $post_id );
		$file_array = array(
			'name'     => sprintf( '%s-%d-%d.pdf', $stem, $post_id, time() ),
			'tmp_name' => $tmp_file,
			'type'     => 'application/pdf',
			'error'    => 0,
			'size'     => filesize( $tmp_file ),
		);

		$attachment_id = media_handle_sideload( $file_array, $post_id );
		@unlink( $tmp_file ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged

		if ( is_wp_error( $attachment_id ) ) {
			throw new \RuntimeException( $attachment_id->get_error_message() );
		}

		if ( taxonomy_exists( '_media_visibility' ) ) {
			wp_set_object_terms( $attachment_id, 'hidden', '_media_visibility' );
		}

		$previous = (int) get_post_meta( $post_id, self::META_ATTACHMENT_ID, true );
		if ( $previous && $previous !== (int) $attachment_id ) {
			wp_delete_attachment( $previous, true );
		}

		$pdf_url = wp_get_attachment_url( $attachment_id );
		update_post_meta( $post_id, self::META_ATTACHMENT_ID, (int) $attachment_id );
		update_post_meta( $post_id, self::META_PDF_URL, $pdf_url ? $pdf_url : '' );
		update_post_meta( $post_id, self::META_CONTENT_HASH, $this->compute_content_hash( $post ) );
		update_post_meta( $post_id, self::META_GENERATED_AT, gmdate( 'c' ) );
	}

	/**
	 * Call the Firebase generatePdf function and return PDF bytes.
	 *
	 * @param string $print_url Absolute /print URL.
	 * @return string|\WP_Error
	 */
	public function request_pdf_bytes( string $print_url ) {
		$endpoints = self::get_endpoints();
		$endpoint  = $endpoints['generate_pdf'] ?? '';
		if ( '' === $endpoint ) {
			return new \WP_Error( 'print_engine_pdf', 'generate_pdf endpoint is not configured.' );
		}

		$firebase = new \PRC\Platform\Firebase();
		$id_token = $firebase->get_id_token( $endpoint );
		if ( is_wp_error( $id_token ) ) {
			return $id_token;
		}

		$response = wp_remote_post(
			$endpoint,
			array(
				'timeout' => 300,
				'headers' => array(
					'Authorization' => 'Bearer ' . $id_token,
					'Content-Type'  => 'application/json',
					'Accept'        => 'application/pdf',
				),
				'body'    => wp_json_encode( array( 'url' => $print_url ) ),
			)
		);

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = wp_remote_retrieve_body( $response );

		if ( $code < 200 || $code >= 300 || '' === $body ) {
			$message = 'PDF generation failed';
			$json    = json_decode( $body, true );
			if ( is_array( $json ) && ! empty( $json['error'] ) ) {
				$message = (string) $json['error'];
			}
			return new \WP_Error(
				'print_engine_pdf',
				$message,
				array(
					'status' => $code,
					'body'   => $body,
				)
			);
		}

		return $body;
	}

	/**
	 * Call the Firebase screenshotElement function and return PNG bytes.
	 *
	 * @param string $url      Absolute page URL.
	 * @param string $selector CSS selector.
	 * @param int    $wait_ms  Optional wait timeout.
	 * @return string|\WP_Error
	 */
	public function request_screenshot_bytes( string $url, string $selector, int $wait_ms = 10000 ) {
		$endpoints = self::get_endpoints();
		$endpoint  = $endpoints['screenshot_element'] ?? '';
		if ( '' === $endpoint ) {
			return new \WP_Error( 'print_engine_screenshot', 'screenshot_element endpoint is not configured.' );
		}

		$firebase = new \PRC\Platform\Firebase();
		$id_token = $firebase->get_id_token( $endpoint );
		if ( is_wp_error( $id_token ) ) {
			return $id_token;
		}

		$response = wp_remote_post(
			$endpoint,
			array(
				'timeout' => 120,
				'headers' => array(
					'Authorization' => 'Bearer ' . $id_token,
					'Content-Type'  => 'application/json',
					'Accept'        => 'image/png',
				),
				'body'    => wp_json_encode(
					array(
						'url'      => $url,
						'selector' => $selector,
						'waitMs'   => $wait_ms,
					)
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = wp_remote_retrieve_body( $response );

		if ( $code < 200 || $code >= 300 || '' === $body ) {
			$message = 'Screenshot failed';
			$json    = json_decode( $body, true );
			if ( is_array( $json ) && ! empty( $json['error'] ) ) {
				$message = (string) $json['error'];
			}
			return new \WP_Error(
				'print_engine_screenshot',
				$message,
				array( 'status' => $code )
			);
		}

		return $body;
	}

	/**
	 * Current PDF status payload for REST / editor.
	 *
	 * Resolves report chapters to the parent package owner so status matches
	 * the attachment used by the /print download button.
	 *
	 * @param int $post_id Post ID.
	 * @return array<string, mixed>
	 */
	public static function get_status( int $post_id ): array {
		$post = get_post( $post_id );
		if ( $post instanceof \WP_Post ) {
			$owner = self::resolve_pdf_owner_post( $post );
			if ( $owner instanceof \WP_Post ) {
				$post_id = (int) $owner->ID;
			}
		}

		$attachment_id = (int) get_post_meta( $post_id, self::META_ATTACHMENT_ID, true );
		$url           = (string) get_post_meta( $post_id, self::META_PDF_URL, true );
		if ( $attachment_id && '' === $url ) {
			$resolved = wp_get_attachment_url( $attachment_id );
			$url      = $resolved ? $resolved : '';
		}

		return array(
			'attachmentId' => $attachment_id,
			'url'          => $url,
			'generatedAt'  => (string) get_post_meta( $post_id, self::META_GENERATED_AT, true ),
			'configured'   => self::is_configured(),
			'pending'      => self::is_action_pending( $post_id ),
		);
	}
}
