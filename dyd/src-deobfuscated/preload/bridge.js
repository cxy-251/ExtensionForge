const {
  contextBridge,ipcRenderer
}=require("electron");
function _0x52d9(_0x3df91e,_0x3fb72b){
  const _0x2bd5c0=_0x2bd5();
  return _0x52d9=function(_0x52d956,_0x37f328){
    _0x52d956=_0x52d956-300;
    let _0x3ee10e=_0x2bd5c0[_0x52d956];
    return _0x3ee10e;
  },_0x52d9(_0x3df91e,_0x3fb72b);
}contextBridge.exposeInMainWorld("electron",{
  'ipcRenderer':ipcRenderer
});
