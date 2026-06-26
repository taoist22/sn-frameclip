import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager} from 'sn-plugin-lib';

const BUTTON_TYPE_TOOLBAR = 1;
const SHOW_TYPE_WITH_UI = 1;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(BUTTON_TYPE_TOOLBAR, ['NOTE', 'DOC'], {
  id: 100,
  name: 'FrameClip',
  icon: Image.resolveAssetSource(require('./assets/clipper.png')).uri,
  showType: SHOW_TYPE_WITH_UI,
});
