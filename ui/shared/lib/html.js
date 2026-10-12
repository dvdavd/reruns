// Single binding point for the view layer, so components import `html` from
// here rather than reaching into vendor/ directly.
import {h} from '../../vendor/preact/preact.module.js';
import htm from '../../vendor/preact/htm.module.js';

export const html = htm.bind(h);
export {Fragment} from '../../vendor/preact/preact.module.js';
