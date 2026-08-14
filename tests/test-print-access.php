<?php
declare(strict_types=1);
/**
 * Lightweight tests for Print_Access machine-fetch tickets.
 *
 * Run with:
 *   php plugins/prc-print-engine/tests/test-print-access.php
 *
 * @package PRC\Platform\Print_Engine
 */

namespace {

	if ( ! function_exists( 'is_user_logged_in' ) ) {
		function is_user_logged_in(): bool {
			return ! empty( $GLOBALS['__print_access_logged_in'] );
		}
	}

	if ( ! function_exists( 'wp_unslash' ) ) {
		function wp_unslash( $value ) {
			return $value;
		}
	}

	if ( ! function_exists( 'sanitize_text_field' ) ) {
		function sanitize_text_field( $str ) {
			return is_string( $str ) ? trim( $str ) : '';
		}
	}

	if ( ! function_exists( 'add_query_arg' ) ) {
		function add_query_arg( $args, $url ) {
			$separator = false !== strpos( $url, '?' ) ? '&' : '?';
			return $url . $separator . http_build_query( $args );
		}
	}

	if ( ! function_exists( 'wp_salt' ) ) {
		function wp_salt( $scheme = 'auth' ) {
			return 'test-auth-salt-' . $scheme;
		}
	}

	if ( ! function_exists( 'apply_filters' ) ) {
		function apply_filters( $hook, $value ) {
			if ( 'prc_print_engine_machine_fetch_key' === $hook && isset( $GLOBALS['__print_access_key'] ) ) {
				return $GLOBALS['__print_access_key'];
			}
			return $value;
		}
	}

	if ( ! class_exists( 'WP_Post' ) ) {
		class WP_Post {
			public $ID = 0;
		}
	}
}

namespace PRC\Platform\Print_Engine {

	require_once dirname( __DIR__ ) . '/includes/class-print-access.php';

	$failures = 0;
	$assert   = static function ( bool $cond, string $msg ) use ( &$failures ): void {
		if ( ! $cond ) {
			fwrite( STDERR, "FAIL: {$msg}\n" );
			++$failures;
			return;
		}
		fwrite( STDOUT, "OK: {$msg}\n" );
	};

	$GLOBALS['__print_access_logged_in'] = false;
	$GLOBALS['__print_access_key']       = 'unit-test-machine-key';
	$_GET                                = array();

	$post     = new \WP_Post();
	$post->ID = 42;

	$assert(
		false === Print_Access::audience_may_see_print_ui(),
		'audience_may_see_print_ui is false when logged out'
	);
	$assert(
		false === Print_Access::request_may_access_print( $post ),
		'request_may_access_print is false without login or ticket'
	);

	$GLOBALS['__print_access_logged_in'] = true;
	$assert(
		true === Print_Access::audience_may_see_print_ui(),
		'audience_may_see_print_ui is true when logged in'
	);
	$assert(
		true === Print_Access::request_may_access_print( $post ),
		'request_may_access_print is true when logged in'
	);

	$GLOBALS['__print_access_logged_in'] = false;

	$minted = Print_Access::mint_machine_fetch_url( 'https://example.com/post/print', 42, 600 );
	$assert(
		false !== strpos( $minted, Print_Access::MACHINE_QUERY_VAR . '=' ),
		'mint_machine_fetch_url adds machine query var'
	);
	$assert(
		false !== strpos( $minted, Print_Access::MACHINE_EXPIRES_QUERY_VAR . '=' ),
		'mint_machine_fetch_url adds expires query var'
	);

	$query_string = (string) ( parse_url( $minted, PHP_URL_QUERY ) ?? '' );
	$query        = array();
	parse_str( $query_string, $query );
	$_GET = $query;

	$assert(
		true === Print_Access::request_may_access_print( $post ),
		'valid machine ticket authorizes matching post'
	);

	$other     = new \WP_Post();
	$other->ID = 99;
	$assert(
		false === Print_Access::request_may_access_print( $other ),
		'machine ticket does not authorize a different post'
	);

	$_GET[ Print_Access::MACHINE_EXPIRES_QUERY_VAR ] = (string) ( time() - 10 );
	$expires                                         = (int) $_GET[ Print_Access::MACHINE_EXPIRES_QUERY_VAR ];
	$_GET[ Print_Access::MACHINE_QUERY_VAR ]         = hash_hmac(
		'sha256',
		'42|' . $expires,
		'unit-test-machine-key'
	);
	$assert(
		false === Print_Access::request_may_access_print( $post ),
		'expired machine ticket is rejected'
	);

	$_GET  = array();
	$qvars = Print_Access::register_query_vars( array( 'print' ) );
	$assert(
		in_array( Print_Access::MACHINE_QUERY_VAR, $qvars, true ),
		'register_query_vars includes machine var'
	);
	$assert(
		in_array( Print_Access::MACHINE_EXPIRES_QUERY_VAR, $qvars, true ),
		'register_query_vars includes expires var'
	);

	if ( $failures > 0 ) {
		fwrite( STDERR, "\n{$failures} failure(s)\n" );
		exit( 1 );
	}

	fwrite( STDOUT, "\nAll Print_Access tests passed.\n" );
	exit( 0 );
}
