<?php
declare(strict_types=1);
/**
 * Lightweight unit tests for Block_Print_Registry.
 *
 * Run with:
 *   php plugins/prc-print-engine/tests/test-block-print-registry.php
 *
 * @package PRC\Platform\Print_Engine
 */

namespace PRC\Platform\Print_Engine {

	require_once dirname( __DIR__ ) . '/includes/class-block-print-registry.php';

	Block_Print_Registry::reset();

	$failures = 0;

	$assert = static function ( bool $cond, string $msg ) use ( &$failures ): void {
		if ( ! $cond ) {
			fwrite( STDERR, "FAIL: {$msg}\n" );
			++$failures;
			return;
		}
		fwrite( STDOUT, "OK: {$msg}\n" );
	};

	$callback = static function ( string $content, array $block, \WP_Post $post ): string {
		return '<div class="print">' . $content . '</div>';
	};

	Block_Print_Registry::register( 'test/block', $callback );
	$assert( Block_Print_Registry::has( 'test/block' ), 'has() after register' );
	$assert( Block_Print_Registry::get( 'test/block' ) === $callback, 'get() returns registered callback' );

	Block_Print_Registry::register_style( 'test/block', '.print { color: red; }' );
	Block_Print_Registry::register_print_style( 'test/block', '.print { break-inside: avoid; }' );

	$styles = Block_Print_Registry::get_all_styles();
	$assert( in_array( '.print { color: red; }', $styles, true ), 'get_all_styles includes raw CSS' );

	$print_styles = Block_Print_Registry::get_all_print_styles();
	$assert( in_array( '.print { break-inside: avoid; }', $print_styles, true ), 'get_all_print_styles includes raw CSS' );

	Block_Print_Registry::reset();
	$assert( ! Block_Print_Registry::has( 'test/block' ), 'reset() clears callbacks' );
	$assert( array() === Block_Print_Registry::get_all_styles(), 'reset() clears styles' );
	$assert( array() === Block_Print_Registry::get_all_print_styles(), 'reset() clears print styles' );

	if ( $failures > 0 ) {
		fwrite( STDERR, "\n{$failures} failure(s)\n" );
		exit( 1 );
	}

	fwrite( STDOUT, "\nAll Block_Print_Registry tests passed.\n" );
	exit( 0 );
}
