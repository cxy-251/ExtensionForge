const {
  Application
}=require("ee-core"),{
  nativeTheme
}=require("electron");
class Index extends Application{
  constructor(){
    super();
  }async.ready(){
  }async.electronAppReady(){
  }async.windowReady(){
    const _0x5e6731=_0x14d64c,_0x5e727c=console.log;
    console.log=(..._0x446861)=>{
    };
    const _0x17f9e6=this.config.windowsOption;
    if(_0x17f9e6.show==![]){
      const _0x2efaa9=this.electron.mainWindow;
      _0x2efaa9.once("ready-to-show",()=>{
        _0x2efaa9.show(),_0x2efaa9.focus();
      });
    }nativeTheme.themeSource="dark";
  }async.beforeClose(){
  }
}function _0x5612(_0x3723ca,_0x10decf){
  const _0x27e8c9=_0x27e8();
  return _0x5612=function(_0x561265,_0x4a25a1){
    _0x561265=_0x561265-203;
    let _0x5c070c=_0x27e8c9[_0x561265];
    return _0x5c070c;
  },_0x5612(_0x3723ca,_0x10decf);
}Index.toString=()=>"[class Index]",module.exports=Index;
