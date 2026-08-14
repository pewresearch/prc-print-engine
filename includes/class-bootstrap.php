<?php
/**
 * Bootstrap class.
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine;

/**
 * Bootstrap class for plugin initialization.
 *
 * @package PRC\Platform\Print_Engine
 */
class Bootstrap {

	/**
	 * The loader responsible for maintaining and registering all hooks.
	 *
	 * @var Loader
	 */
	protected $loader;

	/**
	 * Plugin name.
	 *
	 * @var string
	 */
	protected $plugin_name;

	/**
	 * Plugin version.
	 *
	 * @var string
	 */
	protected $version;

	/**
	 * Initialize the plugin.
	 */
	public function __construct() {
		$this->plugin_name = 'prc-print-engine';
		$this->version     = PRC_PRINT_ENGINE_VERSION;

		$this->load_dependencies();
		$this->register_modules();
		$this->register_back_compat_aliases();
	}

	/**
	 * Load required dependencies.
	 */
	private function load_dependencies() {
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-loader.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-block-print-registry.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-print-engine.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-print-access.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-rewrite-rules.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-discovery.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-pdf-export.php';
		require_once PRC_PRINT_ENGINE_DIR . '/includes/class-rest-api.php';

		$this->loader = new Loader();
	}

	/**
	 * Register all plugin modules.
	 */
	private function register_modules() {
		new Print_Engine( $this->get_loader() );
		new Rewrite_Rules( $this->get_loader() );
		new Discovery( $this->get_loader() );

		$pdf_export = new Pdf_Export( $this->get_loader() );
		new Rest_Api( $this->get_loader(), $pdf_export );

		$this->loader->add_action( 'init', $this, 'register_post_type_support', 5 );
	}

	/**
	 * Opt-in post type support for the print engine.
	 *
	 * @hook init, 5
	 */
	public function register_post_type_support() {
		add_post_type_support( 'post', 'prc-print-engine' );
		add_post_type_support( 'page', 'prc-print-engine' );
	}

	/**
	 * Temporary class aliases for consumers still importing the old namespace.
	 *
	 * Prefer updating consumers to PRC\Platform\Print_Engine\* in the same release.
	 */
	private function register_back_compat_aliases() {
		if ( ! class_exists( 'PRC\\Platform\\Blocks\\Block_Print_Registry', false ) ) {
			class_alias( Block_Print_Registry::class, 'PRC\\Platform\\Blocks\\Block_Print_Registry' );
		}
		if ( ! class_exists( 'PRC\\Platform\\Blocks\\Print_Engine', false ) ) {
			class_alias( Print_Engine::class, 'PRC\\Platform\\Blocks\\Print_Engine' );
		}
	}

	/**
	 * The reference to the class that orchestrates the hooks with the plugin.
	 *
	 * @return Loader
	 */
	public function get_loader() {
		return $this->loader;
	}

	/**
	 * Retrieve the version number of the plugin.
	 *
	 * @return string
	 */
	public function get_version() {
		return $this->version;
	}

	/**
	 * Run the loader to execute all of the hooks with WordPress.
	 */
	public function run() {
		$this->loader->run();
	}
}
