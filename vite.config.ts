import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	optimizeDeps: {
		exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
	},
	server: {
		host: '0.0.0.0',
		port: 5173,
		allowedHosts: true
	},
	preview: {
		host: '0.0.0.0',
		port: 4173,
		allowedHosts: true
	}
});
