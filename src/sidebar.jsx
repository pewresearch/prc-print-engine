/**
 * Print Engine plugin sidebar — ad-hoc PDF generation for the current post.
 *
 * Only surfaces in the `post` block editor. Hidden in the site editor and for
 * every other post type (pages, templates, custom types).
 */

import { registerPlugin } from '@wordpress/plugins';
import {
	PluginSidebar,
	PluginSidebarMoreMenuItem,
	store as editorStore,
} from '@wordpress/editor';
import { __ } from '@wordpress/i18n';
import { useDispatch, useSelect } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import {
	Button,
	ExternalLink,
	PanelBody,
	Spinner,
} from '@wordpress/components';
import { useCallback, useEffect, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

const PLUGIN_NAME = 'prc-print-engine';
const SUPPORTED_POST_TYPE = 'post';

const printIcon = (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		width="24"
		height="24"
	>
		<path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z" />
	</svg>
);

function getConfig() {
	return (
		window.prcPrintEngine || {
			restBase: '',
			restNonce: '',
			pdf: {
				configured: false,
				url: '',
				generatedAt: '',
				pending: false,
			},
		}
	);
}

function PrintEngineSidebarPanel() {
	const { postId, postType } = useSelect((select) => {
		const editor = select(editorStore);
		return {
			postId: editor?.getCurrentPostId?.() || 0,
			postType: editor?.getCurrentPostType?.() || '',
		};
	}, []);
	const { createSuccessNotice, createErrorNotice } =
		useDispatch(noticesStore);

	const config = getConfig();
	const [status, setStatus] = useState(config.pdf || {});
	const [busy, setBusy] = useState(false);

	const refreshStatus = useCallback(async () => {
		if (!postId || !config.restBase) {
			return;
		}
		try {
			const next = await apiFetch({
				path: `/prc-print-engine/v1/posts/${postId}/pdf`,
			});
			setStatus(next || {});
		} catch (e) {
			// Keep last known status.
		}
	}, [postId, config.restBase]);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	useEffect(() => {
		if (!status?.pending) {
			return undefined;
		}
		const timer = setInterval(() => {
			void refreshStatus();
		}, 5000);
		return () => clearInterval(timer);
	}, [status?.pending, refreshStatus]);

	const onGenerate = async () => {
		if (!postId) {
			return;
		}
		setBusy(true);
		try {
			const next = await apiFetch({
				path: `/prc-print-engine/v1/posts/${postId}/generate-pdf`,
				method: 'POST',
			});
			setStatus(next || {});
			createSuccessNotice(
				__(
					'PDF generation queued. This may take a minute for long reports.',
					'prc-print-engine'
				),
				{ type: 'snackbar' }
			);
		} catch (error) {
			createErrorNotice(
				error?.message ||
					__('Could not queue PDF generation.', 'prc-print-engine'),
				{ type: 'snackbar' }
			);
		} finally {
			setBusy(false);
		}
	};

	const configured = Boolean(status?.configured ?? config.pdf?.configured);
	const pdfUrl = status?.url || '';
	const generatedAt = status?.generatedAt || '';
	const pending = Boolean(status?.pending) || busy;

	return (
		<PanelBody
			title={__('PDF export', 'prc-print-engine')}
			initialOpen={true}
		>
			{!configured && (
				<p>
					{__(
						'The Firebase PDF render service is not configured in this environment.',
						'prc-print-engine'
					)}
				</p>
			)}
			{configured && (
				<>
					<p>
						{__(
							'Generate a stored PDF from the /print layout. Publishing or updating this post also queues a fresh PDF automatically.',
							'prc-print-engine'
						)}
					</p>
					{pdfUrl ? (
						<p>
							<strong>
								{__('Current PDF:', 'prc-print-engine')}
							</strong>{' '}
							<ExternalLink href={pdfUrl}>
								{__('Open download', 'prc-print-engine')}
							</ExternalLink>
						</p>
					) : (
						<p>
							{__(
								'No PDF has been generated yet.',
								'prc-print-engine'
							)}
						</p>
					)}
					{generatedAt && (
						<p>
							{__('Last generated:', 'prc-print-engine')}{' '}
							{new Date(generatedAt).toLocaleString()}
						</p>
					)}
					<div
						style={{
							display: 'flex',
							gap: '0.5rem',
							alignItems: 'center',
						}}
					>
						<Button
							variant="primary"
							onClick={onGenerate}
							disabled={pending || !postId || !postType}
						>
							{pdfUrl
								? __('Update PDF', 'prc-print-engine')
								: __('Generate PDF', 'prc-print-engine')}
						</Button>
						{pending && <Spinner />}
					</div>
				</>
			)}
		</PanelBody>
	);
}

function PrintEngineSidebar() {
	const postType = useSelect(
		(select) => select(editorStore)?.getCurrentPostType?.() || '',
		[]
	);

	// Site editor and non-post CPTs share the plugins API; keep the sidebar
	// out of every surface except the standard post block editor.
	if (postType !== SUPPORTED_POST_TYPE) {
		return null;
	}

	return (
		<>
			<PluginSidebarMoreMenuItem target={PLUGIN_NAME} icon={printIcon}>
				{__('Print Engine', 'prc-print-engine')}
			</PluginSidebarMoreMenuItem>
			<PluginSidebar
				name={PLUGIN_NAME}
				title={__('Print Engine', 'prc-print-engine')}
				icon={printIcon}
			>
				<PrintEngineSidebarPanel />
			</PluginSidebar>
		</>
	);
}

registerPlugin(PLUGIN_NAME, {
	render: PrintEngineSidebar,
	icon: printIcon,
});
