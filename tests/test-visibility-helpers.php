<?php
declare(strict_types=1);
/**
 * Lightweight tests for print visibility attribute dual-read.
 *
 * Run with:
 *   php plugins/prc-print-engine/tests/test-visibility-helpers.php
 *
 * @package PRC\Platform\Print_Engine
 */

namespace {

	if ( ! class_exists( 'WP_HTML_Tag_Processor' ) ) {
		/**
		 * Minimal stub — not exercised by these attribute-resolution tests.
		 */
		class WP_HTML_Tag_Processor {
			public function __construct( string $html ) {}
			public function next_tag(): bool {
				return false;
			}
			public function set_attribute( string $name, string $value ): void {}
			public function get_attribute( string $name ) {
				return null;
			}
			public function get_updated_html(): string {
				return '';
			}
		}
	}

	if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
		class WP_Block_Type_Registry {
			private static $instance = null;
			public static function get_instance() {
				return self::$instance ??= new self();
			}
			public function get_all_registered(): array {
				return array();
			}
		}
	}

	if ( ! class_exists( 'WP_Block' ) ) {
		class WP_Block {}
	}

	if ( ! defined( 'PRC_PRINT_ENGINE_VERSION' ) ) {
		define( 'PRC_PRINT_ENGINE_VERSION', '0.0.0-test' );
	}
	if ( ! defined( 'PRC_PRINT_ENGINE_FILE' ) ) {
		define( 'PRC_PRINT_ENGINE_FILE', dirname( __DIR__ ) . '/prc-print-engine.php' );
	}
}

namespace PRC\Platform\Print_Engine {

	require_once dirname( __DIR__ ) . '/includes/class-loader.php';
	require_once dirname( __DIR__ ) . '/includes/class-block-print-registry.php';
	require_once dirname( __DIR__ ) . '/includes/class-print-engine.php';

	$failures = 0;
	$assert   = static function ( bool $cond, string $msg ) use ( &$failures ): void {
		if ( ! $cond ) {
			fwrite( STDERR, "FAIL: {$msg}\n" );
			++$failures;
			return;
		}
		fwrite( STDOUT, "OK: {$msg}\n" );
	};

	$engine = new class() extends Print_Engine {
		public function __construct() {
			// Skip asset/hook init for unit helper tests.
		}

		public function expose_options( array $attributes ): array {
			$ref = new \ReflectionClass( Print_Engine::class );
			$m   = $ref->getMethod( 'get_print_visibility_options' );
			$m->setAccessible( true );
			return $m->invoke( $this, $attributes );
		}
	};

	$nested = $engine->expose_options(
		array(
			'blockVisibility' => array(
				'printEngine' => array(
					'hideOnPrint'    => true,
					'displayOnPrint' => false,
				),
			),
		)
	);
	$assert( true === $nested['hideOnPrint'], 'reads blockVisibility.printEngine.hideOnPrint' );
	$assert( false === $nested['displayOnPrint'], 'reads blockVisibility.printEngine.displayOnPrint' );

	$legacy = $engine->expose_options(
		array(
			'printEngine' => array(
				'hideOnPrint'    => false,
				'displayOnPrint' => true,
			),
		)
	);
	$assert( false === $legacy['hideOnPrint'], 'reads legacy root printEngine.hideOnPrint' );
	$assert( true === $legacy['displayOnPrint'], 'reads legacy root printEngine.displayOnPrint' );

	$prefer_nested = $engine->expose_options(
		array(
			'printEngine'     => array(
				'hideOnPrint' => true,
			),
			'blockVisibility' => array(
				'printEngine' => array(
					'hideOnPrint' => false,
				),
			),
		)
	);
	$assert( false === $prefer_nested['hideOnPrint'], 'blockVisibility.printEngine wins over legacy root' );

	if ( $failures > 0 ) {
		fwrite( STDERR, "\n{$failures} failure(s)\n" );
		exit( 1 );
	}

	fwrite( STDOUT, "\nAll visibility helper tests passed.\n" );
	exit( 0 );
}
