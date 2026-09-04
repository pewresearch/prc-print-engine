<?php
/**
 * Print Engine
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

use MatthiasMullie\Minify;
use WP_HTML_Tag_Processor;
use WP_Block_Type_Registry;

/**
 * Print Engine Supports
 */
class Print_Engine {
	/**
	 * Script/style handle.
	 *
	 * @var string
	 */
	public static $handle = 'prc-print-engine';

	/**
	 * Webpack view asset manifest.
	 *
	 * @var array
	 */
	public static $view_asset_file;

	/**
	 * Webpack editor controls asset manifest.
	 *
	 * @var array
	 */
	public static $controls_asset_file;

	/**
	 * Asset version string.
	 *
	 * @var string
	 */
	public static $version;

	/**
	 * Whether the current request is actively serving a print document.
	 *
	 * @var bool
	 */
	private static $serving_print = false;

	/**
	 * Post currently being served on the print route (when set via parse_request).
	 *
	 * @var \WP_Post|null
	 */
	private static $print_post = null;

	/**
	 * Display widths (px) for Excel/Illustrator chart image size classes.
	 *
	 * @var array<string, int>
	 */
	private const PRINT_SIZED_IMAGE_WIDTHS = array(
		'size-200-wide' => 200,
		'size-310-wide' => 310,
		'size-420-wide' => 420,
		'size-640-wide' => 640,
	);

	/**
	 * Constructor.
	 *
	 * @param object $loader Hook loader.
	 */
	public function __construct( $loader ) {
		$view_asset_path     = plugin_dir_path( __DIR__ ) . 'build/view.asset.php';
		$controls_asset_path = plugin_dir_path( __DIR__ ) . 'build/index.asset.php';

		self::$view_asset_file = is_readable( $view_asset_path )
			? include $view_asset_path
			: array(
				'dependencies' => array(),
				'version'      => PRC_PRINT_ENGINE_VERSION,
			);
		self::$version             = self::$view_asset_file['version'] ?? PRC_PRINT_ENGINE_VERSION;
		self::$controls_asset_file = is_readable( $controls_asset_path )
			? include $controls_asset_path
			: array(
				'dependencies' => array(),
				'version'      => PRC_PRINT_ENGINE_VERSION,
			);

		self::$instance = $this;
		$this->init( $loader );
	}

	/**
	 * Register hooks.
	 *
	 * @param object $loader Hook loader.
	 */
	public function init( $loader ) {
		$loader->add_action( 'init', $this, 'fire_block_print_registration', 5 );
		$loader->add_filter( 'query_vars', $this, 'add_query_vars' );
		$loader->add_action( 'wp_enqueue_scripts', $this, 'register_view_script' );
		$loader->add_action( 'enqueue_block_editor_assets', $this, 'register_editor_script' );
		$loader->add_action( 'enqueue_block_assets', $this, 'register_style' );
		$loader->add_filter( 'block_type_metadata', $this, 'add_attributes', 100, 1 );
		// Short-circuit registered print blocks before they render so chart
		// interactivity state / script modules are never registered on /print.
		// Priority 999: run last so earlier pre_render_block callbacks cannot
		// overwrite our non-null print HTML with null.
		$loader->add_filter( 'pre_render_block', $this, 'pre_render_block', 999, 2 );
		$loader->add_filter( 'render_block', $this, 'render', 100, 2 );
	}

	/**
	 * Fire the action that allows other plugins to register block print callbacks.
	 *
	 * Runs at init priority 5 so registrations happen before most block work.
	 *
	 * @hook init, 5
	 */
	public function fire_block_print_registration() {
		/**
		 * Fires when plugins should register their block print callbacks and styles.
		 *
		 * Use Block_Print_Registry::register() and Block_Print_Registry::register_style()
		 * inside this action.
		 *
		 * @since 1.0.0
		 */
		do_action( 'prc_print_engine_register_block_callbacks' );
	}

	/**
	 * Register print query vars.
	 *
	 * @hook query_vars
	 * @param array $qvars Query vars.
	 * @return array
	 */
	public function add_query_vars( $qvars ) {
		$qvars[] = 'print';
		$qvars[] = 'pdf';
		return Print_Access::register_query_vars( $qvars );
	}

	/**
	 * Whether the current request is for the print document.
	 *
	 * True while actively serving `/print`, on a `/print` path, or the legacy `?pdf=true` alias.
	 *
	 * @return bool
	 */
	public function is_print_view() {
		if ( self::$serving_print ) {
			return true;
		}

		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$path        = wp_parse_url( $request_uri, PHP_URL_PATH );
		if ( is_string( $path ) && preg_match( '#/print/?$#', $path ) ) {
			return true;
		}

		// Legacy alias (Rewrite_Rules normally 302s to /print first).
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET['pdf'] ) ) {
			$raw = wp_unslash( $_GET['pdf'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			if ( ! is_string( $raw ) ) {
				return false;
			}
			$val = strtolower( sanitize_text_field( $raw ) );
			return in_array( $val, array( '1', 'true', 'yes', 'on' ), true );
		}

		return false;
	}

	/**
	 * Back-compat alias for is_print_view().
	 *
	 * @return bool
	 */
	public function is_pdf_view() {
		return $this->is_print_view();
	}

	/**
	 * Whether print may be served for this post.
	 *
	 * @param \WP_Post $post Post object.
	 * @return bool
	 */
	public static function can_serve_print_for_post( \WP_Post $post ): bool {
		if ( ! post_type_supports( $post->post_type, 'prc-print-engine' ) ) {
			return false;
		}

		if ( ! empty( $post->post_password ) ) {
			require_once ABSPATH . WPINC . '/post-template.php';
			if ( post_password_required( $post ) ) {
				// Password required and not yet provided — only allow capable users.
				return current_user_can( 'read_post', $post->ID );
			}
			// Valid password cookie — still require publish / capability / preview below.
		}

		if ( 'publish' === $post->post_status ) {
			return true;
		}

		if ( current_user_can( 'read_post', $post->ID ) ) {
			return true;
		}

		if ( ! empty( $_GET['preview'] ) && isset( $_GET['preview_nonce'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$nonce = sanitize_text_field( wp_unslash( $_GET['preview_nonce'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended

			return (bool) wp_verify_nonce( $nonce, 'post_preview_' . $post->ID );
		}

		return false;
	}

	/**
	 * Build the public /print URL for a post.
	 *
	 * @param \WP_Post $post Post object.
	 * @return string|null
	 */
	public static function get_print_url( \WP_Post $post ): ?string {
		$permalink = get_permalink( $post );
		if ( ! $permalink ) {
			return null;
		}

		return trailingslashit( $permalink ) . 'print';
	}

	/**
	 * Singleton instance registered with the plugin loader (for serve()).
	 *
	 * @var self|null
	 */
	private static $instance = null;

	/**
	 * Serve the print document for a post and exit.
	 *
	 * @param \WP_Post $post Post object.
	 * @return void
	 */
	public static function serve( \WP_Post $post ): void {
		if ( ! self::$instance instanceof self ) {
			status_header( 500 );
			exit;
		}
		self::$instance->output_print_document( $post );
		exit;
	}

	/**
	 * Output the full print HTML document.
	 *
	 * @param \WP_Post $post Post object.
	 * @return void
	 */
	public function output_print_document( \WP_Post $post ): void {
		self::$serving_print = true;
		self::$print_post    = $post;

		// Prime main query globals so block filters / the_content behave.
		global $wp_query;
		if ( $wp_query instanceof \WP_Query ) {
			$wp_query->queried_object    = $post;
			$wp_query->queried_object_id = $post->ID;
			$wp_query->is_singular       = true;
			$wp_query->is_single         = ( 'page' !== $post->post_type );
			$wp_query->is_page           = ( 'page' === $post->post_type );
			$wp_query->is_404            = false;
			$wp_query->posts             = array( $post );
			$wp_query->post_count        = 1;
			$wp_query->post              = $post;
		}
		$GLOBALS['post'] = $post; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		setup_postdata( $post );

		status_header( 200 );

		$is_public = ( 'publish' === $post->post_status && empty( $post->post_password ) );
		if ( $is_public ) {
			header( 'Cache-Control: public, max-age=300' );
			header( 'Vary: Cookie' );
		} else {
			nocache_headers();
			header( 'Vary: Cookie' );
		}

		// parse_request exits before wp_enqueue_scripts — enqueue assets now.
		$this->register_view_script();
		$this->register_style();
		// Keep theme/block styles (logo sizes, image alignment). Only suppress
		// chart script-modules that dump megabytes of interactivity JSON.
		$this->suppress_print_document_script_modules();

		$is_report   = $this->is_report_package( $post->ID );
		$report_post = $is_report ? $this->get_report_parent_post( $post ) : $post;

		// Pre-pass: strip front-matter and extract About / Pew-Knight details for the about page.
		$research_html   = '';
		$pew_knight_html = '';
		$body_html       = '';
		$seen_hashes     = array();

		if ( $is_report ) {
			$cover_title = get_the_title( $report_post );
			foreach ( $this->get_all_report_posts( $report_post ) as $chapter_post ) {
				$prepared         = $this->prepare_print_body( $chapter_post, $seen_hashes );
				$research_html   .= $prepared['research_html'];
				$pew_knight_html .= $prepared['pew_knight_html'];
				$body_html       .= $this->render_chapter_content(
					$chapter_post,
					$prepared['content'],
					$cover_title
				);
			}
		} else {
			$prepared        = $this->prepare_print_body( $report_post, $seen_hashes );
			$research_html   = $prepared['research_html'];
			$pew_knight_html = $prepared['pew_knight_html'];
			$body_html       = $this->render_article_content( $report_post, $prepared['content'] );
		}

		$permalink = get_the_permalink( $report_post );
		$stored_pdf = (string) get_post_meta( $report_post->ID, Pdf_Export::META_PDF_URL, true );
		if ( '' === $stored_pdf ) {
			$attachment_id = (int) get_post_meta( $report_post->ID, Pdf_Export::META_ATTACHMENT_ID, true );
			if ( $attachment_id ) {
				$resolved = wp_get_attachment_url( $attachment_id );
				$stored_pdf = $resolved ? $resolved : '';
			}
		}

		?>
		<!DOCTYPE html>
		<html <?php language_attributes(); ?>>
		<head>
			<meta charset="<?php bloginfo( 'charset' ); ?>">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<meta name="robots" content="noindex, nofollow">
			<meta name="color-scheme" content="only light">
			<title><?php echo esc_html( get_the_title( $report_post ) ); ?> - PDF Preview</title>
			<?php
			// Chrome UI only — must NOT use id prefix prc-print-engine (Paged.js would unwrap @media print).
			// Light-only SVG (adaptive pew-knight.svg still flips under OS dark as background-image).
			$pew_knight_logo = content_url( 'images/logos/pew-knight-light.svg' );
			?>
			<style id="print-engine-chrome">
				/* Pin light tokens before theme global-styles (light-dark / color-scheme). */
				:root {
					color-scheme: only light !important;
				}
				.print-engine-actions {
					position: fixed;
					top: 1rem;
					right: 1rem;
					z-index: 9999;
					display: flex;
					flex-direction: column;
					gap: 0.5rem;
				}
				.print-engine-actions__btn {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 2.75rem;
					height: 2.75rem;
					padding: 0;
					border: none;
					border-radius: 9999px;
					background: #333;
					color: #fff;
					cursor: pointer;
					box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
					text-decoration: none;
					transition: background 0.15s ease, opacity 0.15s ease;
				}
				.print-engine-actions__btn:hover:not(:disabled) {
					background: #bd7912;
					color: #000;
				}
				.print-engine-actions__btn:disabled {
					opacity: 0.45;
					cursor: wait;
				}
				.print-engine-actions__btn svg {
					width: 1.25rem;
					height: 1.25rem;
					fill: currentColor;
				}
				/* Keep co-branded details marks on the light logo when OS is dark. */
				.print-engine-pdf-view .wp-block-details.is-style-pew-knight-co-branded > summary:before {
					display: flex;
					content: "";
					width: 183px;
					height: 35px;
					background-image: url(<?php echo esc_url( $pew_knight_logo ); ?>) !important;
					background-repeat: no-repeat;
					background-size: contain;
					background-position: center;
				}
				@media screen and (prefers-color-scheme: dark) {
					.print-engine-actions__btn {
						background: #4a4a4a;
						box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
					}
					.print-engine-actions__btn:hover:not(:disabled) {
						background: #bd7912;
						color: #000;
					}
				}
				@media print {
					.print-engine-actions {
						display: none !important;
					}
				}
			</style>
			<?php wp_head(); ?>
		</head>
		<body class="print-engine-pdf-view print-engine-print-view">
			<nav class="print-engine-actions" aria-label="<?php esc_attr_e( 'Print actions', 'prc-print-engine' ); ?>">
				<button
					type="button"
					id="print-engine-print-pdf"
					class="print-engine-actions__btn"
					aria-label="<?php esc_attr_e( 'Print', 'prc-print-engine' ); ?>"
					data-label="<?php esc_attr_e( 'Print', 'prc-print-engine' ); ?>"
					title="<?php esc_attr_e( 'Preparing pages…', 'prc-print-engine' ); ?>"
					disabled
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>
				</button>
				<button
					type="button"
					id="print-engine-download-pdf"
					class="print-engine-actions__btn"
					aria-label="<?php esc_attr_e( 'Download PDF', 'prc-print-engine' ); ?>"
					data-label="<?php esc_attr_e( 'Download PDF', 'prc-print-engine' ); ?>"
					title="<?php esc_attr_e( 'Preparing pages…', 'prc-print-engine' ); ?>"
					<?php if ( '' !== $stored_pdf ) : ?>
						data-pdf-url="<?php echo esc_url( $stored_pdf ); ?>"
					<?php endif; ?>
					disabled
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
				</button>
				<a
					id="print-engine-web-view"
					class="print-engine-actions__btn"
					href="<?php echo esc_url( $permalink ); ?>"
					aria-label="<?php esc_attr_e( 'View on website', 'prc-print-engine' ); ?>"
					title="<?php esc_attr_e( 'View on website', 'prc-print-engine' ); ?>"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
				</a>
			</nav>
			<div id="print-engine-content" class="print-engine-pdf-content">
				<?php echo $this->render_cover_sheet( $report_post ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				<?php echo $this->render_about_page( $report_post, $research_html, $pew_knight_html ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				<?php echo $this->render_table_of_contents( $report_post, $research_html, $pew_knight_html ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				<?php echo $body_html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
			</div>
			<?php wp_footer(); ?>
		</body>
		</html>
		<?php
	}

	/**
	 * Enqueue block-editor controls (visibility + post PDF sidebar).
	 *
	 * Skips the site editor. The PDF sidebar itself is further limited to the
	 * `post` post type in JS (`src/sidebar.jsx`).
	 *
	 * @hook enqueue_block_editor_assets
	 * @return void
	 */
	public function register_editor_script() {
		global $pagenow;

		// PluginSidebar is unified across editors; do not load in site editor.
		if ( 'site-editor.php' === $pagenow ) {
			return;
		}

		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( $screen && 'site-editor' === $screen->id ) {
			return;
		}

		$handle = self::$handle . '-controls';
		wp_enqueue_script(
			$handle,
			plugins_url( 'build/index.js', PRC_PRINT_ENGINE_FILE ),
			self::$controls_asset_file['dependencies'],
			self::$version,
			true
		);

		$post_id = 0;
		if ( function_exists( 'get_the_ID' ) ) {
			$post_id = (int) get_the_ID();
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( ! $post_id && isset( $_GET['post'] ) ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$post_id = absint( $_GET['post'] );
		}

		// PDF sidebar config is only meaningful on the post block editor.
		$is_post_editor = $screen && 'post' === $screen->base && 'post' === $screen->post_type;
		$status         = array(
			'attachmentId' => 0,
			'url'          => '',
			'generatedAt'  => '',
			'configured'   => Pdf_Export::is_configured(),
			'pending'      => false,
		);
		if ( $is_post_editor && $post_id ) {
			$status = Pdf_Export::get_status( $post_id );
		}

		wp_localize_script(
			$handle,
			'prcPrintEngine',
			array(
				'restBase'  => esc_url_raw( rest_url( Rest_Api::NAMESPACE ) ),
				'restNonce' => wp_create_nonce( 'wp_rest' ),
				'postId'    => $is_post_editor ? $post_id : 0,
				'pdf'       => $status,
			)
		);
	}

	/**
	 * Whether print-engine transforms should run for this request.
	 *
	 * Only true while actively serving a print document — not merely because the
	 * URL path looks like /print (denied/404 requests must not rewrite blocks).
	 *
	 * @return bool
	 */
	public function allow_print_engine() {
		return true === self::$serving_print;
	}

	/**
	 * Enqueue the print document view script.
	 *
	 * @hook wp_enqueue_scripts
	 * @return void
	 */
	public function register_view_script() {
		if ( true !== $this->allow_print_engine() ) {
			return;
		}
		wp_enqueue_script(
			self::$handle,
			plugins_url( 'build/view.js', PRC_PRINT_ENGINE_FILE ),
			self::$view_asset_file['dependencies'],
			self::$version,
			true
		);
	}

	/**
	 * Suppress WordPress script modules on the /print document.
	 *
	 * Chart builder registers Interactivity API state during render; on large
	 * reports that dumps megabytes of JSON into the footer and can throw during
	 * Paged.js layout. Block/theme stylesheets stay enqueued so logo sizes,
	 * image alignment, and other print chrome keep working.
	 *
	 * @return void
	 */
	private function suppress_print_document_script_modules(): void {
		if ( ! function_exists( 'wp_script_modules' ) ) {
			return;
		}

		$modules = wp_script_modules();
		remove_action( 'wp_head', array( $modules, 'print_head_enqueued_script_modules' ) );
		remove_action( 'wp_footer', array( $modules, 'print_enqueued_script_modules' ) );
		remove_action( 'wp_head', array( $modules, 'print_script_module_preloads' ) );
		remove_action( 'wp_footer', array( $modules, 'print_script_module_preloads' ) );
		remove_action( 'wp_footer', array( $modules, 'print_script_module_data' ) );
		remove_action( 'wp_footer', array( $modules, 'print_script_module_translations' ), 21 );
		remove_action( 'wp_footer', array( $modules, 'print_a11y_script_module_html' ), 20 );
	}

	/**
	 * List registered block names, optionally filtered by namespace.
	 *
	 * @param string|null $filter_by_namespace Namespace prefix, or null for all.
	 * @return string[]
	 */
	public function get_block_names( $filter_by_namespace = null ) {
		$block_names = array();
		$block_types = WP_Block_Type_Registry::get_instance()->get_all_registered();
		foreach ( $block_types as $block_type ) {
			if ( ! is_null( $filter_by_namespace ) && strpos( $block_type->name, $filter_by_namespace ) === 0 ) {
				$block_names[] = $block_type->name;
			} elseif ( is_null( $filter_by_namespace ) ) {
				$block_names[] = $block_type->name;
			}
		}
		return $block_names;
	}

	/**
	 * Print registered block print styles into the print document stylesheet.
	 *
	 * @return void
	 */
	public function register_block_styles() {
		// Print-view styles: output bare, no @media wrapper.
		// Applies to the print engine web page (?pdf=true).
		$view_styles = Block_Print_Registry::get_all_styles();
		if ( ! empty( $view_styles ) ) {
			$css      = implode( "\n", $view_styles );
			$minifier = new Minify\CSS( $css );
			wp_add_inline_style( self::$handle, $minifier->minify() );
		}

		// @media print styles: wrapped for browser print dialog / html2pdf.
		$print_styles = Block_Print_Registry::get_all_print_styles();
		if ( ! empty( $print_styles ) ) {
			$css      = '@media print { ' . implode( "\n", $print_styles ) . ' }';
			$minifier = new Minify\CSS( $css );
			wp_add_inline_style( self::$handle, $minifier->minify() );
		}
	}

	/**
	 * Enqueue print document styles and Typekit fonts.
	 *
	 * @hook enqueue_block_assets
	 * @return void
	 */
	public function register_style() {
		if ( true !== $this->allow_print_engine() ) {
			return;
		}

		// Typekit Franklin Gothic (same kit as the design system theme).
		if ( ! wp_style_is( 'prc-design-system-font-families', 'registered' ) ) {
			wp_register_style(
				'prc-design-system-font-families',
				'https://use.typekit.net/tic0xoy.css',
				array(),
				self::$version
			);
		}
		wp_enqueue_style( 'prc-design-system-font-families' );

		wp_enqueue_style(
			self::$handle,
			plugins_url( 'build/view.css', PRC_PRINT_ENGINE_FILE ),
			array( 'prc-design-system-font-families' ),
			self::$version
		);
		$this->register_block_styles();
	}

	/**
	 * Register additional attributes for the core-group block.
	 *
	 * @hook block_type_metadata 100, 1
	 * @param mixed $metadata Block type metadata.
	 * @return mixed
	 */
	public function add_attributes( $metadata ) {
		if ( is_array( $metadata ) && array_key_exists( 'attributes', $metadata ) && ! array_key_exists( 'printEngine', $metadata['attributes'] ) ) {
			$metadata['attributes']['printEngine'] = array(
				'type'    => 'object',
				'default' => array(
					'hideOnPrint'    => false,
					'displayOnPrint' => false,
				),
			);
		}

		return $metadata;
	}

	/**
	 * Check if a post is part of a report package (either parent or chapter).
	 *
	 * @param int $post_id The post ID.
	 * @return bool True if post is a report or part of a report.
	 */
	private function is_report_package( $post_id ) {
		if ( ! function_exists( '\PRC\Platform\Report_Package\is_report_package' ) ) {
			return false;
		}
		return \PRC\Platform\Report_Package\is_report_package( $post_id )
			|| \PRC\Platform\Report_Package\is_chapter_part_of_report_package( $post_id );
	}

	/**
	 * Get the parent report post for a given post.
	 * If the post is already the parent, returns itself.
	 *
	 * @param WP_Post $post The post object.
	 * @return WP_Post|null The parent report post or null if not found.
	 */
	private function get_report_parent_post( $post ) {
		if ( ! function_exists( '\PRC\Platform\Report_Package\get_package_id' ) ) {
			return $post;
		}
		$parent_id   = \PRC\Platform\Report_Package\get_package_id( $post->ID );
		$parent_post = get_post( $parent_id );
		return $parent_post ? $parent_post : $post;
	}

	/**
	 * Get all posts in a report package (parent + chapters) in order.
	 *
	 * @param WP_Post $parent_post The parent report post.
	 * @return array Array of WP_Post objects in order.
	 */
	private function get_all_report_posts( $parent_post ) {
		if ( ! function_exists( '\PRC\Platform\Report_Package\get_package_chapters' ) ) {
			return array( $parent_post );
		}
		$chapters = \PRC\Platform\Report_Package\get_package_chapters( $parent_post->ID );
		if ( empty( $chapters ) ) {
			return array( $parent_post );
		}
		$posts = array();
		foreach ( $chapters as $chapter ) {
			$chapter_post = get_post( $chapter['id'] );
			if ( $chapter_post && 'publish' === $chapter_post->post_status ) {
				$posts[] = $chapter_post;
			}
		}
		return $posts;
	}

	/**
	 * Resolve brand profile for cover logo and about page copy.
	 *
	 * Pew-Knight Initiative reports are tagged with the `collection` term
	 * `pew-knight-initiative`.
	 *
	 * @param int $post_id Post ID.
	 * @return array{slug:string,logo_url:string,logo_alt:string,about_title:string,about_html:string}
	 */
	private function get_brand_profile( $post_id ) {
		$current_year = gmdate( 'Y' );
		$is_pew_knight = has_term( 'pew-knight-initiative', 'collection', $post_id );

		if ( $is_pew_knight ) {
			$profile = array(
				'slug'         => 'pew-knight',
				'logo_url'     => content_url( 'images/logos/pew-knight-light.svg' ),
				'logo_alt'     => 'Pew-Knight Initiative',
				'about_title'  => 'About the Pew-Knight Initiative',
				'about_html'   => '<p>The Pew-Knight Initiative supports new research on how Americans absorb civic information, form beliefs and identities, and engage in their communities. Pew Research Center is a nonpartisan, nonadvocacy fact tank that informs the public about the issues, attitudes and trends shaping the world. Knight Foundation is a social investor committed to supporting informed and engaged communities.</p>'
					. '<p class="print-engine-about__copyright">&copy; Pew Research Center ' . esc_html( $current_year ) . '</p>',
			);
		} else {
			$profile = array(
				'slug'         => 'prc',
				'logo_url'     => content_url( 'images/logos/primary-light.svg' ),
				'logo_alt'     => 'Pew Research Center',
				'about_title'  => 'About Pew Research Center',
				'about_html'   => '<p>Pew Research Center is a nonpartisan, nonadvocacy fact tank that informs the public about the issues, attitudes and trends shaping the world. It does not take policy positions. The Center conducts public opinion polling, demographic research, computational social science research and other data-driven research. It studies politics and policy; news habits and media; the internet and technology; religion; race and ethnicity; international affairs; social, demographic and economic trends; science; research methodology and data science; and immigration and migration. Pew Research Center is a subsidiary of The Pew Charitable Trusts, its primary funder.</p>'
					. '<p class="print-engine-about__copyright">&copy; Pew Research Center ' . esc_html( $current_year ) . '</p>',
			);
		}

		/**
		 * Filter the print-engine brand profile (logo + about copy).
		 *
		 * @param array $profile Brand profile.
		 * @param int   $post_id Post ID.
		 */
		return apply_filters( 'prc_print_engine_brand_profile', $profile, (int) $post_id );
	}

	/**
	 * Cover subtitle: prefer sub_title meta, then legacy sub_headline, then excerpt.
	 *
	 * @param \WP_Post $post Post object.
	 * @return string
	 */
	private function get_cover_subtitle( $post ) {
		$sub_title = get_post_meta( $post->ID, 'sub_title', true );
		if ( is_string( $sub_title ) && '' !== trim( $sub_title ) ) {
			return trim( $sub_title );
		}

		$sub_headline = get_post_meta( $post->ID, 'sub_headline', true );
		if ( is_string( $sub_headline ) && '' !== trim( $sub_headline ) ) {
			return trim( $sub_headline );
		}

		$excerpt = get_the_excerpt( $post );
		return is_string( $excerpt ) ? trim( $excerpt ) : '';
	}

	/**
	 * Get the bylines for a post.
	 *
	 * @param int $post_id The post ID.
	 * @return string The formatted bylines HTML.
	 */
	private function get_bylines_html( $post_id ) {
		if ( ! class_exists( '\PRC\Platform\Staff_Bylines\Bylines' ) ) {
			return '';
		}

		$bylines = new \PRC\Platform\Staff_Bylines\Bylines( (int) $post_id );
		if ( is_wp_error( $bylines->bylines ) || false === $bylines->should_display ) {
			return '';
		}

		$bylines_output = $bylines->format( 'string' );
		if ( 2 >= strlen( $bylines_output ) ) {
			return '';
		}

		return '<p class="print-engine-cover__bylines"><strong class="print-engine-cover__by">BY</strong> <span class="print-engine-cover__byline-names">' . esc_html( $bylines_output ) . '</span></p>';
	}

	/**
	 * Generate recommended citation for a post (cover house style).
	 *
	 * @param WP_Post $post The post object.
	 * @return string The formatted citation.
	 */
	private function get_recommended_citation( $post ) {
		$month_year = get_the_date( 'F Y', $post );
		$title      = get_the_title( $post );

		return sprintf(
			'Pew Research Center, %s, "%s"',
			esc_html( $month_year ),
			esc_html( $title )
		);
	}

	/**
	 * Render the cover sheet for the PDF.
	 *
	 * @param WP_Post $post The post object.
	 * @return string The cover sheet HTML.
	 */
	public function render_cover_sheet( $post ) {
		$title    = get_the_title( $post );
		$subtitle = $this->get_cover_subtitle( $post );
		$date     = get_the_date( 'F j, Y', $post );
		$bylines  = $this->get_bylines_html( $post->ID );
		$citation = $this->get_recommended_citation( $post );
		$brand    = $this->get_brand_profile( $post->ID );
		$contact  = $this->get_media_contact( $post->ID );
		$site_url = 'https://www.pewresearch.org';

		ob_start();
		?>
		<section class="print-engine-page print-engine-cover">
			<header class="print-engine-cover__header">
				<img src="<?php echo esc_url( $brand['logo_url'] ); ?>" alt="<?php echo esc_attr( $brand['logo_alt'] ); ?>" class="print-engine-cover__logo" />
			</header>
			<div class="print-engine-cover__content">
				<p class="print-engine-cover__date">FOR RELEASE <?php echo esc_html( strtoupper( $date ) ); ?></p>
				<h1 class="print-engine-cover__title"><?php echo esc_html( $title ); ?></h1>
				<?php if ( ! empty( $subtitle ) ) : ?>
					<p class="print-engine-cover__subtitle"><?php echo esc_html( $subtitle ); ?></p>
				<?php endif; ?>
				<?php echo $bylines; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
			</div>
			<footer class="print-engine-cover__footer">
				<div class="print-engine-cover__media-contacts">
					<h3>FOR MEDIA OR OTHER INQUIRIES:</h3>
					<p>
						<strong><?php echo esc_html( $contact['name'] ); ?></strong><?php if ( ! empty( $contact['title'] ) ) : ?>
							<span class="print-engine-cover__contact-title">, <?php echo esc_html( $contact['title'] ); ?></span><?php endif; ?><br>
						<?php if ( ! empty( $contact['phone'] ) ) : ?>
							<?php echo esc_html( $contact['phone'] ); ?><br>
						<?php endif; ?>
						<?php if ( ! empty( $contact['email'] ) ) : ?>
							<a href="mailto:<?php echo esc_attr( $contact['email'] ); ?>"><?php echo esc_html( $contact['email'] ); ?></a><br>
						<?php endif; ?>
						<a href="<?php echo esc_url( $site_url ); ?>">www.pewresearch.org</a>
					</p>
				</div>
				<div class="print-engine-cover__citation">
					<h3>RECOMMENDED CITATION</h3>
					<p><?php echo $citation; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?></p>
				</div>
			</footer>
		</section>
		<?php
		return ob_get_clean();
	}

	/**
	 * Get the media contact for a post.
	 *
	 * Uses the Contact_Resolver from prc-schema-seo if available,
	 * otherwise falls back to default contact info.
	 *
	 * @param int $post_id The post ID.
	 * @return array Contact data with name, title, phone, email, url keys.
	 */
	private function get_media_contact( $post_id ) {
		// Try to use Contact_Resolver from prc-schema-seo plugin.
		if ( class_exists( '\PRC\Platform\Schema_SEO\Contact_Resolver' ) ) {
			return \PRC\Platform\Schema_SEO\Contact_Resolver::get_contact_for_post( $post_id );
		}

		// Fallback to default contact info.
		return array(
			'name'  => 'Communications Department',
			'title' => '',
			'phone' => '202.419.4372',
			'email' => '',
			'url'   => 'https://www.pewresearch.org',
		);
	}

	/**
	 * Render the About page (PRC or Pew-Knight brand profile + extracted details).
	 *
	 * @param \WP_Post $post             The post object.
	 * @param string   $research_html    Inner HTML from "About this research" details.
	 * @param string   $pew_knight_html  Inner HTML from Pew-Knight details.
	 * @return string The about page HTML.
	 */
	public function render_about_page( $post, $research_html = '', $pew_knight_html = '' ) {
		$brand = $this->get_brand_profile( $post->ID );

		// The Pew-Knight brand profile already carries the initiative blurb —
		// the extracted co-branded details would repeat the same copy.
		if ( 'pew-knight' === ( $brand['slug'] ?? '' ) ) {
			$pew_knight_html = '';
		}

		$has_research   = '' !== trim( (string) $research_html );
		$has_pew_knight = '' !== trim( (string) $pew_knight_html );

		ob_start();
		?>
		<section id="print-engine-about" class="print-engine-page print-engine-about">
			<div class="print-engine-about__content">
				<h2 class="print-engine-about__title"><?php echo esc_html( $brand['about_title'] ); ?></h2>
				<?php echo wp_kses_post( $brand['about_html'] ); ?>
			</div>
		</section>
		<?php if ( $has_research || $has_pew_knight ) : ?>
		<section id="print-engine-about-research" class="print-engine-page print-engine-about-research">
			<div class="print-engine-about-research__content">
				<?php if ( $has_pew_knight ) : ?>
					<div class="print-engine-about-research__extracted print-engine-about-research__extracted--pew-knight">
						<?php echo $pew_knight_html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
					</div>
				<?php endif; ?>
				<?php if ( $has_research ) : ?>
					<div class="print-engine-about-research__extracted print-engine-about-research__extracted--research">
						<h3 class="print-engine-about-research__subtitle">About this research</h3>
						<?php echo $research_html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
					</div>
				<?php endif; ?>
			</div>
		</section>
		<?php endif; ?>
		<?php
		return ob_get_clean();
	}

	/**
	 * Return extracted HTML only if its normalized text has not been seen before.
	 *
	 * Chapters in a report package often repeat the same About-this-research /
	 * Pew-Knight details block; the about page should show each once. Normalization
	 * decodes entities and folds non-breaking spaces so Word-paste variants match.
	 *
	 * @param string $html Extracted inner HTML.
	 * @param array  $seen Seen-hash accumulator (passed by reference).
	 * @return string Original HTML, or empty string when duplicate.
	 */
	private function dedupe_extracted_html( string $html, array &$seen ): string {
		if ( '' === trim( $html ) ) {
			return '';
		}
		$text = wp_strip_all_tags( html_entity_decode( $html, ENT_QUOTES | ENT_HTML5 ) );
		$text = str_replace( "\xC2\xA0", ' ', $text ); // U+00A0 NBSP.
		$normalized = strtolower( trim( (string) preg_replace( '/\s+/u', ' ', $text ) ) );
		$key        = md5( $normalized );
		if ( isset( $seen[ $key ] ) ) {
			return '';
		}
		$seen[ $key ] = true;
		return $html;
	}

	/**
	 * Prepare post body for print: strip opening chrome and extract about details.
	 *
	 * Strips consecutive opening front-matter (duplicate title/dek, first image,
	 * About-this-research / Pew-Knight details). Also removes those details if they
	 * appear later so they only live on the about page.
	 *
	 * @param \WP_Post $post         Post object.
	 * @param array    $seen_hashes  Shared seen-hash set for cross-chapter dedupe.
	 * @return array{content:string,research_html:string,pew_knight_html:string}
	 */
	private function prepare_print_body( \WP_Post $post, array &$seen_hashes = array() ): array {
		$blocks               = parse_blocks( (string) $post->post_content );
		$post_title           = get_the_title( $post );
		$research_html        = '';
		$pew_knight_html      = '';
		$stripped_first_image = false;
		$count                = count( $blocks );
		$i                    = 0;

		while ( $i < $count ) {
			$block = $blocks[ $i ];
			$name  = $block['blockName'] ?? null;

			if ( null === $name && '' === trim( (string) ( $block['innerHTML'] ?? '' ) ) ) {
				++$i;
				continue;
			}

			if ( 'core/pattern' === $name || 'core/block' === $name ) {
				$ref_blocks = 'core/pattern' === $name
					? $this->expand_pattern_block( $block )
					: $this->expand_reusable_block( $block );
				if ( null !== $ref_blocks ) {
					$cleaned = $this->strip_extractable_details_from_blocks(
						$ref_blocks,
						$research_html,
						$pew_knight_html,
						$seen_hashes
					);
					if ( empty( $cleaned ) ) {
						++$i;
						continue;
					}
					// Expand pattern/reusable in place so opening strip can keep
					// removing title/dek/hero chrome from the spliced blocks.
					array_splice( $blocks, $i, 1, $cleaned );
					$count = count( $blocks );
					continue;
				}
				break;
			}

			if ( 'core/post-title' === $name ) {
				++$i;
				continue;
			}

			if ( 'core/heading' === $name ) {
				$text  = trim( wp_strip_all_tags( (string) ( $block['innerHTML'] ?? '' ) ) );
				$class = (string) ( $block['attrs']['className'] ?? '' );
				if (
					false !== stripos( $class, 'is-style-sub-title' ) ||
					$this->titles_match( $text, $post_title )
				) {
					++$i;
					continue;
				}
				break;
			}

			if ( 'core/image' === $name && ! $stripped_first_image ) {
				$stripped_first_image = true;
				++$i;
				continue;
			}

			if ( 'core/details' === $name ) {
				$kind = $this->classify_details_block( $block );
				if ( 'research' === $kind ) {
					$research_html .= $this->dedupe_extracted_html(
						$this->render_details_inner( $block ),
						$seen_hashes
					);
					++$i;
					continue;
				}
				if ( 'pew_knight' === $kind ) {
					$pew_knight_html .= $this->dedupe_extracted_html(
						$this->render_details_inner( $block ),
						$seen_hashes
					);
					++$i;
					continue;
				}
				break;
			}

			if ( in_array( $name, array( 'core/group', 'core/columns', 'core/column' ), true ) ) {
				$cleaned = $this->strip_extractable_details_from_blocks(
					array( $block ),
					$research_html,
					$pew_knight_html,
					$seen_hashes
				);
				if ( empty( $cleaned ) ) {
					++$i;
					continue;
				}
				// Replace this container with its cleaned form and stop opening strip.
				$blocks[ $i ] = $cleaned[0];
				break;
			}

			break;
		}

		$remaining = array_slice( $blocks, $i );

		// Continue opening strip through groups that only wrap extractable chrome
		// (Pew-Knight details are often nested in core/group).
		while ( ! empty( $remaining ) ) {
			$block = $remaining[0];
			$name  = $block['blockName'] ?? null;
			if ( 'core/group' !== $name && 'core/columns' !== $name && 'core/column' !== $name ) {
				break;
			}
			$cleaned = $this->strip_extractable_details_from_blocks(
				array( $block ),
				$research_html,
				$pew_knight_html,
				$seen_hashes
			);
			array_shift( $remaining );
			if ( empty( $cleaned ) ) {
				continue; // whole group was extractable chrome — keep stripping.
			}
			// Group still has body content; put cleaned group back and stop opening strip.
			$remaining = array_merge( $cleaned, $remaining );
			break;
		}

		$kept = $this->strip_extractable_details_from_blocks(
			$remaining,
			$research_html,
			$pew_knight_html,
			$seen_hashes
		);

		$content = '';
		foreach ( $kept as $block ) {
			$content .= serialize_block( $block );
		}

		return array(
			'content'         => $content,
			'research_html'   => $research_html,
			'pew_knight_html' => $pew_knight_html,
		);
	}

	/**
	 * Recursively remove About-this-research / Pew-Knight details from a block list.
	 *
	 * @param array  $blocks           Parsed blocks.
	 * @param string $research_html    Accumulator for research inner HTML.
	 * @param string $pew_knight_html  Accumulator for Pew-Knight inner HTML.
	 * @param array  $seen_hashes      Shared seen-hash set for dedupe.
	 * @return array<int, array> Kept blocks.
	 */
	private function strip_extractable_details_from_blocks( array $blocks, string &$research_html, string &$pew_knight_html, array &$seen_hashes = array() ): array {
		$kept = array();

		foreach ( $blocks as $block ) {
			if ( ! is_array( $block ) ) {
				continue;
			}

			$name = $block['blockName'] ?? null;

			if ( null === $name && '' === trim( (string) ( $block['innerHTML'] ?? '' ) ) ) {
				continue;
			}

			if ( 'core/pattern' === $name || 'core/block' === $name ) {
				$ref_blocks = 'core/pattern' === $name
					? $this->expand_pattern_block( $block )
					: $this->expand_reusable_block( $block );
				if ( null !== $ref_blocks ) {
					$cleaned = $this->strip_extractable_details_from_blocks(
						$ref_blocks,
						$research_html,
						$pew_knight_html,
						$seen_hashes
					);
					if ( empty( $cleaned ) ) {
						continue;
					}
					foreach ( $cleaned as $cleaned_block ) {
						$kept[] = $cleaned_block;
					}
					continue;
				}
				$kept[] = $block;
				continue;
			}

			if ( 'core/details' === $name ) {
				$kind = $this->classify_details_block( $block );
				if ( 'research' === $kind ) {
					$research_html .= $this->dedupe_extracted_html(
						$this->render_details_inner( $block ),
						$seen_hashes
					);
					continue;
				}
				if ( 'pew_knight' === $kind ) {
					$pew_knight_html .= $this->dedupe_extracted_html(
						$this->render_details_inner( $block ),
						$seen_hashes
					);
					continue;
				}
			}

			if ( ! empty( $block['innerBlocks'] ) && is_array( $block['innerBlocks'] ) ) {
				$inners = $this->strip_extractable_details_from_blocks(
					$block['innerBlocks'],
					$research_html,
					$pew_knight_html,
					$seen_hashes
				);
				if ( empty( $inners ) && in_array( $name, array( 'core/group', 'core/columns', 'core/column' ), true ) ) {
					continue;
				}
				if ( $inners !== $block['innerBlocks'] ) {
					$block = $this->rebuild_block_inners( $block, $inners );
				}
			}

			$kept[] = $block;
		}

		return $kept;
	}

	/**
	 * Rebuild a container block after filtering its innerBlocks.
	 *
	 * @param array             $block  Original block.
	 * @param array<int, array> $inners Filtered inner blocks.
	 * @return array
	 */
	private function rebuild_block_inners( array $block, array $inners ): array {
		$block['innerBlocks'] = $inners;

		$leading  = array();
		$trailing = array();
		$original = $block['innerContent'] ?? null;

		// Prefer structured leading/trailing HTML fragments from the original
		// innerContent (may include nested wrappers like group + inner-container
		// or buttons + button). Falling back to first/last single tags from
		// innerHTML drops multi-tag wrappers and can emit orphan </div>s.
		if ( is_array( $original ) ) {
			foreach ( $original as $piece ) {
				if ( null === $piece ) {
					break;
				}
				if ( is_string( $piece ) ) {
					$leading[] = $piece;
				}
			}
			for ( $i = count( $original ) - 1; $i >= 0; $i-- ) {
				if ( null === $original[ $i ] ) {
					break;
				}
				if ( is_string( $original[ $i ] ) ) {
					array_unshift( $trailing, $original[ $i ] );
				}
			}
		}

		if ( empty( $leading ) && empty( $trailing ) ) {
			$inner_html = (string) ( $block['innerHTML'] ?? '' );
			if ( preg_match( '#^(<[a-z][a-z0-9]*\b[^>]*>)#i', $inner_html, $m ) ) {
				$leading[] = $m[1];
			}
			if ( preg_match( '#(</[a-z][a-z0-9]*>)\s*$#i', $inner_html, $m ) ) {
				$trailing[] = $m[1];
			}
		}

		$inner_content = $leading;
		foreach ( $inners as $_inner ) {
			$inner_content[] = null;
		}
		foreach ( $trailing as $piece ) {
			$inner_content[] = $piece;
		}

		$block['innerContent'] = $inner_content;
		$block['innerHTML']    = implode( '', $leading ) . implode( '', $trailing );

		return $block;
	}

	/**
	 * Load full-resolution files for sized chart images and drop Photon srcset.
	 *
	 * Excel/Illustrator chart PNGs use size-{200,310,420,640}-wide classes for
	 * on-page width. Photon `?w=` matches that display size, so print would
	 * rasterize at 1×. Strip size queries so the ~2× file is used, same as
	 * Chart Builder print PNGs.
	 *
	 * @param string $html Post content HTML after `the_content`.
	 * @return string HTML with sized-image srcs upgraded.
	 */
	private function upgrade_print_sized_images( string $html ): string {
		if ( '' === $html || false === strpos( $html, 'size-' ) ) {
			return $html;
		}

		$processor     = new WP_HTML_Tag_Processor( $html );
		$pending_width = null;

		while ( $processor->next_tag() ) {
			$tag = $processor->get_tag();
			if ( 'FIGURE' === $tag ) {
				$pending_width = $this->print_sized_image_width_from_class(
					$processor->get_attribute( 'class' )
				);
				continue;
			}
			if ( 'IMG' !== $tag ) {
				continue;
			}

			$width = $pending_width;
			if ( null === $width ) {
				$width = $this->print_sized_image_width_from_class(
					$processor->get_attribute( 'class' )
				);
			}
			$pending_width = null;

			if ( null === $width ) {
				continue;
			}

			$src = $processor->get_attribute( 'src' );
			if ( is_string( $src ) && '' !== $src ) {
				$processor->set_attribute( 'src', $this->strip_photon_size_query( $src ) );
			}
			$processor->remove_attribute( 'srcset' );
			$processor->remove_attribute( 'sizes' );
		}

		return $processor->get_updated_html();
	}

	/**
	 * Return the print display width for a sized wp-block-image class list.
	 *
	 * @param string|null $class_attr Class attribute value.
	 * @return int|null Width in pixels, or null when the tag is not a sized chart image.
	 */
	private function print_sized_image_width_from_class( $class_attr ): ?int {
		if ( ! is_string( $class_attr ) || '' === $class_attr ) {
			return null;
		}
		$classes = preg_split( '/\s+/', $class_attr, -1, PREG_SPLIT_NO_EMPTY );
		if ( ! is_array( $classes ) || ! in_array( 'wp-block-image', $classes, true ) ) {
			return null;
		}
		foreach ( self::PRINT_SIZED_IMAGE_WIDTHS as $slug => $width ) {
			if ( in_array( $slug, $classes, true ) ) {
				return $width;
			}
		}
		return null;
	}

	/**
	 * Strip Photon/VIP image size query args so the original file is requested.
	 *
	 * @param string $src Image URL.
	 * @return string URL without size queries.
	 */
	private function strip_photon_size_query( string $src ): string {
		return remove_query_arg(
			array( 'w', 'h', 'crop', 'resize', 'fit', 'zoom' ),
			$src
		);
	}

	/**
	 * Drop orphan </div> tags that would close an ancestor outside this fragment.
	 *
	 * Large reports (e.g. Political Typology) can ship rendered block HTML with
	 * a missing wrapper open (commonly core/buttons) but its closing </div>
	 * intact. Inside #print-engine-content that extra close ends the mount node
	 * early; later chapters parse as <body> siblings, so Paged.js only paginates
	 * the overview and TOC target-counters never resolve.
	 *
	 * @param string $html HTML fragment.
	 * @return string HTML with orphan closing divs removed.
	 */
	private function strip_orphan_closing_divs( string $html ): string {
		if ( '' === $html || false === stripos( $html, '</div' ) ) {
			return $html;
		}

		$result = '';
		$depth  = 0;
		$length = strlen( $html );
		$i      = 0;

		while ( $i < $length ) {
			if ( preg_match( '/\G<div\b[^>]*>/i', $html, $match, 0, $i ) ) {
				++$depth;
				$result .= $match[0];
				$i      += strlen( $match[0] );
				continue;
			}

			if ( preg_match( '/\G<\/div\s*>/i', $html, $match, 0, $i ) ) {
				if ( $depth > 0 ) {
					--$depth;
					$result .= $match[0];
				}
				// depth === 0: orphan close — drop it.
				$i += strlen( $match[0] );
				continue;
			}

			$next = strpos( $html, '<', $i );
			if ( false === $next ) {
				$result .= substr( $html, $i );
				break;
			}

			if ( $next === $i ) {
				// Comments / other tags: copy through the next '>'.
				if ( 0 === substr_compare( $html, '<!--', $i, 4 ) ) {
					$end = strpos( $html, '-->', $i + 4 );
					if ( false === $end ) {
						$result .= substr( $html, $i );
						break;
					}
					$result .= substr( $html, $i, $end - $i + 3 );
					$i       = $end + 3;
					continue;
				}

				$end = strpos( $html, '>', $i );
				if ( false === $end ) {
					$result .= substr( $html, $i );
					break;
				}
				$result .= substr( $html, $i, $end - $i + 1 );
				$i       = $end + 1;
				continue;
			}

			$result .= substr( $html, $i, $next - $i );
			$i       = $next;
		}

		return $result;
	}

	/**
	 * Expand a core/pattern block into parsed blocks.
	 *
	 * @param array $block Parsed pattern block.
	 * @return array<int, array>|null
	 */
	private function expand_pattern_block( array $block ): ?array {
		$slug = (string) ( $block['attrs']['slug'] ?? '' );
		if ( '' === $slug || ! class_exists( 'WP_Block_Patterns_Registry' ) ) {
			return null;
		}
		$pattern = \WP_Block_Patterns_Registry::get_instance()->get_registered( $slug );
		if ( ! is_array( $pattern ) || empty( $pattern['content'] ) ) {
			return null;
		}
		return parse_blocks( (string) $pattern['content'] );
	}

	/**
	 * Expand a synced reusable block (core/block) into parsed blocks.
	 *
	 * @param array $block Parsed reusable block with attrs.ref.
	 * @return array<int, array>|null
	 */
	private function expand_reusable_block( array $block ): ?array {
		$ref = isset( $block['attrs']['ref'] ) ? (int) $block['attrs']['ref'] : 0;
		if ( $ref <= 0 ) {
			return null;
		}
		$ref_post = get_post( $ref );
		if ( ! $ref_post instanceof \WP_Post || 'wp_block' !== $ref_post->post_type ) {
			return null;
		}
		if ( empty( $ref_post->post_content ) ) {
			return null;
		}
		return parse_blocks( (string) $ref_post->post_content );
	}

	/**
	 * Whether every non-empty block in a list is an extractable details block.
	 *
	 * @param array<int, array> $blocks      Parsed blocks.
	 * @param array             $seen_hashes Shared seen-hash set for dedupe.
	 * @return array{all_extractable:bool,research_html:string,pew_knight_html:string}
	 */
	private function extract_details_from_blocks( array $blocks, array &$seen_hashes = array() ): array {
		$research_html   = '';
		$pew_knight_html = '';
		$saw_extractable = false;

		foreach ( $blocks as $block ) {
			$name = $block['blockName'] ?? null;
			if ( null === $name && '' === trim( (string) ( $block['innerHTML'] ?? '' ) ) ) {
				continue;
			}
			if ( 'core/details' !== $name ) {
				return array(
					'all_extractable' => false,
					'research_html'   => '',
					'pew_knight_html' => '',
				);
			}
			$kind = $this->classify_details_block( $block );
			if ( '' === $kind ) {
				return array(
					'all_extractable' => false,
					'research_html'   => '',
					'pew_knight_html' => '',
				);
			}
			$saw_extractable = true;
			if ( 'research' === $kind ) {
				$research_html .= $this->dedupe_extracted_html(
					$this->render_details_inner( $block ),
					$seen_hashes
				);
			} else {
				$pew_knight_html .= $this->dedupe_extracted_html(
					$this->render_details_inner( $block ),
					$seen_hashes
				);
			}
		}

		return array(
			'all_extractable' => $saw_extractable,
			'research_html'   => $research_html,
			'pew_knight_html' => $pew_knight_html,
		);
	}

	/**
	 * Classify a core/details block as research, pew_knight, or neither.
	 *
	 * @param array $block Parsed details block.
	 * @return string 'research'|'pew_knight'|''
	 */
	private function classify_details_block( array $block ): string {
		$class = (string) ( $block['attrs']['className'] ?? '' );
		if ( false !== strpos( $class, 'is-style-pew-knight-co-branded' ) ) {
			return 'pew_knight';
		}

		$summary = $this->get_details_summary( $block );
		if ( 'about this research' === $summary ) {
			return 'research';
		}
		if (
			'pew knight initiative' === $summary ||
			'pew-knight initiative' === $summary
		) {
			return 'pew_knight';
		}

		return '';
	}

	/**
	 * Normalize summary text from a core/details block.
	 *
	 * @param array $block Parsed details block.
	 * @return string Lowercased, whitespace-normalized summary.
	 */
	private function get_details_summary( array $block ): string {
		$inner_html = (string) ( $block['innerHTML'] ?? '' );
		if ( '' === $inner_html ) {
			return '';
		}
		if ( 1 !== preg_match( '#<summary\b[^>]*>(.*?)</summary>#is', $inner_html, $matches ) ) {
			return '';
		}
		$summary = wp_strip_all_tags( (string) $matches[1] );
		$summary = html_entity_decode( $summary, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
		$summary = (string) preg_replace( '/\s+/u', ' ', $summary );
		return strtolower( trim( $summary ) );
	}

	/**
	 * Render inner blocks of a details block (no summary chrome).
	 *
	 * @param array $block Parsed details block.
	 * @return string
	 */
	private function render_details_inner( array $block ): string {
		$html = '';
		foreach ( $block['innerBlocks'] ?? array() as $inner ) {
			if ( ! is_array( $inner ) ) {
				continue;
			}
			$html .= render_block( $inner );
		}
		return $html;
	}

	/**
	 * Case-insensitive title comparison.
	 *
	 * @param string $a First title.
	 * @param string $b Second title.
	 * @return bool
	 */
	private function titles_match( string $a, string $b ): bool {
		return strtolower( trim( $a ) ) === strtolower( trim( $b ) );
	}

	/**
	 * Extract H2 headings from post content for table of contents.
	 *
	 * @param \WP_Post $post The post object.
	 * @return array Array of heading items with label and anchor.
	 */
	private function extract_headings_from_content( $post ) {
		$headings = array();
		$blocks   = parse_blocks( $post->post_content );
		$this->find_headings_in_blocks( $blocks, $headings );

		return $headings;
	}

	/**
	 * Recursively find heading blocks in parsed blocks.
	 *
	 * @param array $blocks   The blocks to search.
	 * @param array $headings Reference to headings array to populate.
	 */
	private function find_headings_in_blocks( $blocks, &$headings ) {
		foreach ( $blocks as $block ) {
			if ( 'core/heading' === ( $block['blockName'] ?? '' ) ) {
				$level = isset( $block['attrs']['level'] ) ? (int) $block['attrs']['level'] : 2;
				if ( 2 === $level ) {
					$text = trim( wp_strip_all_tags( $block['innerHTML'] ?? '' ) );
					if ( ! empty( $text ) ) {
						$anchor     = ! empty( $block['attrs']['anchor'] ) ? $block['attrs']['anchor'] : sanitize_title( $text );
						$headings[] = array(
							'label'  => $text,
							'anchor' => $anchor,
						);
					}
				}
			}

			if ( ! empty( $block['innerBlocks'] ) ) {
				$this->find_headings_in_blocks( $block['innerBlocks'], $headings );
			}
		}
	}

	/**
	 * Build static TOC items for a report or article (no Interactivity API / client JS).
	 *
	 * Aligns chapter set with get_all_report_posts() publish filtering. When
	 * package parts exist, emit part labels followed by their published chapters.
	 *
	 * @param \WP_Post $post Parent report or article post.
	 * @return array<int, array{label:string,href:string,is_part?:bool}>
	 */
	private function build_static_toc_items( $post ) {
		$items = array();

		if ( $this->is_report_package( $post->ID ) ) {
			$published = array();
			foreach ( $this->get_all_report_posts( $post ) as $chapter_post ) {
				$published[ (int) $chapter_post->ID ] = $chapter_post;
			}

			$package_parts = get_post_meta( $post->ID, 'package_parts', true );
			if ( is_array( $package_parts ) && ! empty( $package_parts ) ) {
				$placed = array();
				foreach ( $package_parts as $part ) {
					if ( ! is_array( $part ) ) {
						continue;
					}
					$part_label = isset( $part['label'] ) ? (string) $part['label'] : '';
					$part_items = isset( $part['items'] ) && is_array( $part['items'] ) ? $part['items'] : array();
					$part_chapters = array();
					foreach ( $part_items as $chapter_id ) {
						$chapter_id = (int) $chapter_id;
						if ( isset( $published[ $chapter_id ] ) ) {
							$part_chapters[] = $published[ $chapter_id ];
							$placed[ $chapter_id ] = true;
						}
					}
					if ( empty( $part_chapters ) ) {
						continue;
					}
					if ( '' !== $part_label ) {
						$items[] = array(
							'label'   => $part_label,
							'href'    => '#chapter-' . $part_chapters[0]->ID,
							'is_part' => true,
						);
					}
					foreach ( $part_chapters as $chapter_post ) {
						$items[] = array(
							'label'     => get_the_title( $chapter_post ),
							'href'      => '#chapter-' . $chapter_post->ID,
							'is_indent' => '' !== $part_label,
						);
					}
				}
				foreach ( $published as $chapter_id => $chapter_post ) {
					if ( isset( $placed[ $chapter_id ] ) ) {
						continue;
					}
					$items[] = array(
						'label' => get_the_title( $chapter_post ),
						'href'  => '#chapter-' . $chapter_post->ID,
					);
				}
				return $items;
			}

			foreach ( $published as $chapter_post ) {
				$items[] = array(
					'label' => get_the_title( $chapter_post ),
					'href'  => '#chapter-' . $chapter_post->ID,
				);
			}
			return $items;
		}

		foreach ( $this->extract_headings_from_content( $post ) as $heading ) {
			$items[] = array(
				'label' => $heading['label'],
				'href'  => '#' . ltrim( $heading['anchor'], '#' ),
			);
		}

		return $items;
	}

	/**
	 * Render the table of contents page as static HTML (Paged.js target-counter safe).
	 *
	 * @param \WP_Post $post            The post object.
	 * @param string   $research_html   Inner HTML from "About this research" details.
	 * @param string   $pew_knight_html Inner HTML from Pew-Knight details.
	 * @return string The table of contents HTML.
	 */
	public function render_table_of_contents( $post, $research_html = '', $pew_knight_html = '' ) {
		$brand = $this->get_brand_profile( $post->ID );
		$items = $this->build_static_toc_items( $post );

		// Match render_about_page(): Pew-Knight brand already includes that blurb.
		if ( 'pew-knight' === ( $brand['slug'] ?? '' ) ) {
			$pew_knight_html = '';
		}
		$has_research      = '' !== trim( (string) $research_html );
		$has_pew_knight    = '' !== trim( (string) $pew_knight_html );
		$has_research_page = $has_research || $has_pew_knight;

		// Prepend front-matter about pages (brand, then extracted research when present).
		$front_matter = array(
			array(
				'label' => $brand['about_title'],
				'href'  => '#print-engine-about',
			),
		);
		if ( $has_research_page ) {
			// Match render_about_page(): "About this research" heading only when research HTML is present.
			$front_matter[] = array(
				'label' => $has_research ? 'About this research' : 'About the Pew-Knight Initiative',
				'href'  => '#print-engine-about-research',
			);
		}
		$items = array_merge( $front_matter, $items );

		ob_start();
		?>
		<section class="print-engine-page print-engine-toc">
			<h2 class="print-engine-toc__title">Table of contents</h2>
			<?php if ( ! empty( $items ) ) : ?>
				<ul class="print-engine-toc__list">
					<?php foreach ( $items as $item ) : ?>
						<?php
						$item_class = 'print-engine-toc__item';
						if ( ! empty( $item['is_part'] ) ) {
							$item_class .= ' print-engine-toc__item--part';
						}
						if ( ! empty( $item['is_indent'] ) ) {
							$item_class .= ' print-engine-toc__item--indent';
						}
						?>
						<li class="<?php echo esc_attr( $item_class ); ?>">
							<a class="print-engine-toc__link" href="<?php echo esc_url( $item['href'] ); ?>">
								<span class="print-engine-toc__label"><?php echo esc_html( $item['label'] ); ?></span>
								<span class="print-engine-toc__leader" aria-hidden="true"></span>
								<span class="print-engine-toc__page"></span>
							</a>
						</li>
					<?php endforeach; ?>
				</ul>
			<?php endif; ?>
		</section>
		<?php
		return ob_get_clean();
	}

	/**
	 * Hoist the lead floated chart to the top of the body content.
	 *
	 * In the InDesign layout the lead chart sits at the top of the first body
	 * page with text wrapping beside it from the first paragraph. A CSS float
	 * can never rise above its anchor in content order, so when the chart block
	 * sits a few paragraphs in (and the title header eats page space), Paged.js
	 * pushes the whole figure to a later page. Moving the figure to the front
	 * of the content anchors the float at the top. Only applies when the first
	 * left/right-floated chart appears in the lead section (before the first
	 * section heading).
	 *
	 * @param string $content Rendered body content HTML.
	 * @return string
	 */
	private function hoist_lead_floated_chart( string $content ): string {
		$figure_pattern = '/<figure[^>]*class="[^"]*print-engine-chart[^"]*align(?:right|left)[^"]*"[^>]*>.*?<\/figure>/s';
		if ( ! preg_match( $figure_pattern, $content, $matches, PREG_OFFSET_CAPTURE ) ) {
			return $content;
		}

		$figure = $matches[0][0];
		$offset = $matches[0][1];

		$first_heading = PHP_INT_MAX;
		if ( preg_match( '/<h[23][\s>]/', $content, $heading_match, PREG_OFFSET_CAPTURE ) ) {
			$first_heading = $heading_match[0][1];
		}
		if ( $offset > $first_heading ) {
			return $content;
		}

		$content = substr_replace( $content, '', $offset, strlen( $figure ) );
		$figure  = preg_replace( '/class="/', 'class="print-engine-chart--lead ', $figure, 1 );

		return $figure . $content;
	}

	/**
	 * Render the article content.
	 *
	 * @param \WP_Post    $post             The post object.
	 * @param string|null $prepared_content Serialized block content after front-matter strip.
	 * @return string The article content HTML.
	 */
	public function render_article_content( $post, $prepared_content = null ) {
		$title    = get_the_title( $post );
		$subtitle = $this->get_cover_subtitle( $post );
		$raw      = null !== $prepared_content ? $prepared_content : $post->post_content;
		$content = $this->hoist_lead_floated_chart( apply_filters( 'the_content', $raw ) );
		$content = $this->strip_orphan_closing_divs( $content );
		$content = $this->upgrade_print_sized_images( $content );

		ob_start();
		?>
		<article class="print-engine-page print-engine-article">
			<header class="print-engine-body-header">
				<h1 class="print-engine-body-header__title"><?php echo esc_html( $title ); ?></h1>
				<?php if ( ! empty( $subtitle ) ) : ?>
					<p class="print-engine-body-header__subtitle"><?php echo esc_html( $subtitle ); ?></p>
				<?php endif; ?>
			</header>
			<div class="print-engine-article__content">
				<?php echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
			</div>
		</article>
		<?php
		return ob_get_clean();
	}

	/**
	 * Render all chapters of a report package.
	 *
	 * @param \WP_Post $report_post The parent report post.
	 * @return string The combined HTML for all chapters.
	 */
	public function render_report_content( $report_post ) {
		$cover_title = get_the_title( $report_post );
		$posts       = $this->get_all_report_posts( $report_post );
		$seen_hashes = array();
		$output      = '';
		foreach ( $posts as $chapter_post ) {
			$prepared = $this->prepare_print_body( $chapter_post, $seen_hashes );
			$output  .= $this->render_chapter_content(
				$chapter_post,
				$prepared['content'],
				$cover_title
			);
		}
		return $output;
	}

	/**
	 * Render a single chapter's content.
	 *
	 * @param \WP_Post    $chapter_post     The chapter post object.
	 * @param string|null $prepared_content Serialized block content after front-matter strip.
	 * @param string      $cover_title      Parent report title; matching chapter titles are omitted.
	 * @return string The chapter content HTML.
	 */
	private function render_chapter_content( $chapter_post, $prepared_content = null, $cover_title = '' ) {
		$title       = get_the_title( $chapter_post );
		$subtitle    = $this->get_cover_subtitle( $chapter_post );
		$raw         = null !== $prepared_content ? $prepared_content : $chapter_post->post_content;
		$content     = $this->hoist_lead_floated_chart( apply_filters( 'the_content', $raw ) );
		$content     = $this->strip_orphan_closing_divs( $content );
		$content     = $this->upgrade_print_sized_images( $content );
		$is_overview = '' !== $cover_title && $this->titles_match( $title, $cover_title );

		ob_start();
		?>
		<article class="print-engine-page print-engine-chapter" id="chapter-<?php echo esc_attr( $chapter_post->ID ); ?>">
			<?php if ( $is_overview ) : ?>
				<header class="print-engine-body-header">
					<h1 class="print-engine-body-header__title"><?php echo esc_html( $title ); ?></h1>
					<?php if ( ! empty( $subtitle ) ) : ?>
						<p class="print-engine-body-header__subtitle"><?php echo esc_html( $subtitle ); ?></p>
					<?php endif; ?>
				</header>
			<?php else : ?>
				<h2 class="print-engine-chapter__title"><?php echo esc_html( $title ); ?></h2>
			<?php endif; ?>
			<div class="print-engine-chapter__content">
				<?php echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
			</div>
		</article>
		<?php
		return ob_get_clean();
	}

	/**
	 * Resolve printEngine visibility options from block attributes.
	 *
	 * Dual-reads `blockVisibility.printEngine` (current) and root `printEngine` (legacy).
	 *
	 * @param array $attributes Block attributes.
	 * @return array{hideOnPrint:bool,displayOnPrint:bool}
	 */
	private function get_print_visibility_options( array $attributes ): array {
		$print_options = array();

		if (
			isset( $attributes['blockVisibility'] ) &&
			is_array( $attributes['blockVisibility'] ) &&
			isset( $attributes['blockVisibility']['printEngine'] ) &&
			is_array( $attributes['blockVisibility']['printEngine'] )
		) {
			$print_options = $attributes['blockVisibility']['printEngine'];
		} elseif ( isset( $attributes['printEngine'] ) && is_array( $attributes['printEngine'] ) ) {
			$print_options = $attributes['printEngine'];
		}

		return array(
			'hideOnPrint'    => ! empty( $print_options['hideOnPrint'] ),
			'displayOnPrint' => ! empty( $print_options['displayOnPrint'] ),
		);
	}

	/**
	 * Short-circuit registered print blocks before their normal render callback.
	 *
	 * Chart builder (and similar) blocks register Interactivity API state and
	 * enqueue script modules during render. On large reports that produces a
	 * multi-megabyte footer JSON blob and Preact hydration errors that interfere
	 * with Paged.js. Returning print HTML from pre_render_block skips that work.
	 *
	 * @hook pre_render_block, 10, 2
	 * @param string|null $pre_render Existing short-circuit value.
	 * @param array       $block      Parsed block.
	 * @return string|null
	 */
	public function pre_render_block( $pre_render, $block ) {
		if ( null !== $pre_render || true !== $this->allow_print_engine() ) {
			return $pre_render;
		}
		if ( ! is_array( $block ) ) {
			return $pre_render;
		}

		$block_name = $block['blockName'] ?? '';
		$callback   = Block_Print_Registry::get( $block_name );
		if ( ! $callback ) {
			return $pre_render;
		}

		$post = self::$print_post ?? get_post();
		if ( null === $post ) {
			return $pre_render;
		}

		$html = call_user_func( $callback, '', $block, $post );
		$html = apply_filters(
			'prc_print_engine_block_' . $block_name,
			$html,
			$block,
			$post
		);

		return is_string( $html ) ? $html : '';
	}

	/**
	 * Filter rendered block markup for the print document.
	 *
	 * @hook render_block 100, 2
	 * @param mixed $block_content Rendered block HTML.
	 * @param mixed $block         Block array.
	 * @return mixed
	 */
	public function render( $block_content, $block ) {
		if ( true !== $this->allow_print_engine() ) {
			return $block_content;
		}
		if ( is_admin() || ! is_string( $block_content ) ) {
			return $block_content;
		}

		// Print markup callbacks primarily run in pre_render_block (skips
		// interactivity). Keep a render_block fallback so charts still convert
		// if another pre_render_block callback cleared our short-circuit.
		$block_name = $block['blockName'] ?? '';
		$callback   = Block_Print_Registry::get( $block_name );
		if ( $callback ) {
			$already_print = is_string( $block_content )
				&& ( false !== strpos( $block_content, 'print-engine-chart' )
					|| false !== strpos( $block_content, 'print-engine-' ) );
			if ( ! $already_print ) {
				$post = self::$print_post ?? get_post();
				if ( null !== $post ) {
					$block_content = call_user_func( $callback, $block_content, $block, $post );
					$block_content = apply_filters(
						'prc_print_engine_block_' . $block_name,
						$block_content,
						$block,
						$post
					);
				}
			}
		}

		$attributes = ( isset( $block['attrs'] ) && is_array( $block['attrs'] ) ) ? $block['attrs'] : array();
		$options    = $this->get_print_visibility_options( $attributes );

		// html2pdf captures screen DOM — omit/force-show in markup, not CSS-only @media print.
		if ( $options['hideOnPrint'] ) {
			return '';
		}

		if ( $options['displayOnPrint'] && '' !== trim( $block_content ) ) {
			$w = new WP_HTML_Tag_Processor( $block_content );
			if ( $w->next_tag() ) {
				$w->set_attribute( 'data-display-on-print', 'true' );
				$existing = $w->get_attribute( 'style' );
				$force    = 'display:block!important;visibility:visible!important;';
				$w->set_attribute( 'style', is_string( $existing ) ? ( $existing . ';' . $force ) : $force );
				$block_content = $w->get_updated_html();
			}
		}

		return $block_content;
	}
}
