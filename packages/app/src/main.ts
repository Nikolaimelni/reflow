import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.querySelector('#app');
if (target === null) throw new Error('no mount point');

mount(App, { target });
