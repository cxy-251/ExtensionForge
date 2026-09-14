const {
  app,session
}=require("electron"),_=require("lodash"),fs=require('fs'),path=require("path"),Log=require("ee-core/log");
class ChromeExtensionAddon{
  constructor(){
  }async.create(){
    Log.info("[addon:chromeExtension] load");
    const _0x4b7b75=this.getAllIds();
    for(let _0x104e55=0;
    _0x104e55<_0x4b7b75.length;
    _0x104e55++){
      await this.load(_0x4b7b75[_0x104e55]);
    }
  }.getAllIds(){
    const _0x3e811e=_0x417c3c,_0x1507a6=this.getDirectory(),_0x25aac7=this.getDirs(_0x1507a6);
    return _0x25aac7;
  }.getDirectory(){
    let _0x2bb3ac='',_0x18ecaf="build";
    return app.isPackaged&&(_0x18ecaf='..'),_0x2bb3ac=path.join(app.getAppPath(),_0x18ecaf,"extraResources","chromeExtension"),_0x2bb3ac;
  }async.load(_0x5dfb8c=''){
    if(_.isEmpty(_0x5dfb8c))return![];
    try{
      const _0x5ed059=path.join(this.getDirectory(),_0x5dfb8c);
      Log.info("[addon:chromeExtension] extensionPath:",_0x5ed059),await session.defaultSession.loadExtension(_0x5ed059,{
        'allowFileAccess':!![]
      });
    }catch(_0xde9cb6){
      return Log.info("[addon:chromeExtension] load extension error extensionId:%s, errorInfo:%s",_0x5dfb8c,_0xde9cb6.toString()),![];
    }return!![];
  }.getDirs(_0x36c6fe){
    if(!_0x36c6fe)return[];
    const _0x1c2eaf=[],_0x24f0af=fs.readdirSync(_0x36c6fe);
    return _0x24f0af.forEach(function(_0x464b37,_0x3938ee){
      const _0x2a38c5=_0x11be24,_0x21664b=fs.lstatSync(_0x36c6fe+'/'+_0x464b37);
      _0x21664b.isDirectory()===!![]&&_0x1c2eaf.push(_0x464b37);
    }),_0x1c2eaf;
  }
}ChromeExtensionAddon.toString=()=>"[class ChromeExtensionAddon]",module.exports=ChromeExtensionAddon;
