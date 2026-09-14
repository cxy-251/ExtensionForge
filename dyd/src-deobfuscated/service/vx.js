'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon");
class VxService extends Service{
  constructor(_0x241211){
    super(_0x241211),this.bindId=void 0,this.senderId='',this.isInterrupt=![],this.tasks=[];
  }async.isBind(_0x32fcda){
    try{
      this.tasks=[];
      const _0x8a1d1c=await axios.get("https://ci.ak47.ink/Dyd/visBind?bindId="+_0x32fcda.bindId,{
        'timeout':10000
      });
      if(_0x8a1d1c.data.code===200)return this.bindId=_0x32fcda.bindId,this.senderId=_0x8a1d1c.data.senderId,!![];
    }catch(_0x3981ce){
      console.log(_0x3981ce);
    }return![];
  }async.getRoomMsgList(_0x239a61){
    try{
      const _0x3ab095=await axios.get("https://ci.ak47.ink/Dyd/vRoomMsg/"+this.senderId+'/'+this.tasks.length,{
        'timeout':10000
      });
      _0x3ab095.data.forEach(_0x16cf5a=>{
        const _0x3ed096=_0x3353bf,_0x42e850=common.pkgTask("video",_0x16cf5a.objectId,_0x16cf5a.descr,_0x16cf5a.nickname,_0x16cf5a.digg_count,_0x16cf5a.comment_count,_0x16cf5a.share_count,_0x16cf5a.create_time);
        this.tasks[_0x42e850['id']]={
          'title':_0x42e850.title,'poster':_0x16cf5a.poster,'decodeKey':_0x16cf5a.decodeKey,'urls':[_0x16cf5a.url]
        },common.noticeCollectedTask(this.app,_0x42e850);
      });
    }catch(_0x3e14a0){
      console.log(_0x3e14a0);
    }return!![];
  }async.downloadV(_0x4e6bbc){
    let _0x49a479=this.tasks[_0x4e6bbc.task['id']].urls.length>0?this.tasks[_0x4e6bbc.task['id']].urls.splice(0,1)[0]:null;
    if(!_0x49a479)return common.noticeDownloadProgress(this.app,_0x4e6bbc,-999);
    _0x4e6bbc.task.title=this.tasks[_0x4e6bbc.task['id']].title,common.prepare(_0x4e6bbc,'vx');
    if(_0x4e6bbc.settings.poster)Addon.get("axDownloader").download(this.tasks[_0x4e6bbc.task['id']].poster,{
      'outPath':_0x4e6bbc.absolutePath+".jpg",'skipDownloaded':!![]
    });
    fs.existsSync(path.join(_0x4e6bbc.outDir,_0x4e6bbc.filterFileName+".mp4"))?common.noticeDownloadProgress(this.app,_0x4e6bbc,100,path.join(_0x4e6bbc.outDir,_0x4e6bbc.filterFileName+".mp4").toString()):Addon.get("axDownloader").download("https://ci.ak47.ink/Dyd/vIsaac64Data/"+this.tasks[_0x4e6bbc.task['id']].decodeKey,{
      'outPath':_0x4e6bbc.absolutePath+".key",'skipDownloaded':!![]
    }).then(_0x3fc637=>{
      download(this.app.mainWindow,_0x49a479,{
        'directory':_0x4e6bbc.outDir,'filename':_0x4e6bbc.filterFileName+".mp4",'onStarted':_0x3f7759=>this.downloadItem=_0x3f7759,'onProgress':_0x2e1e60=>{
          let _0xbe760c=parseInt(_0x2e1e60.percent*100);
          common.noticeDownloadProgress(this.app,_0x4e6bbc,_0xbe760c);
        }
      }).then(_0x2cb1ad=>{
        setTimeout(async()=>{
          try{
            const _0x57c7bf=131072,_0x337f72=fs.readFileSync(_0x4e6bbc.absolutePath+".key");
            fs.open(_0x2cb1ad.getSavePath(),'r+',(_0x10afe0,_0x41fa6e)=>{
              const _0x36ccd2=_0x30fb73,_0x49e0f2=Buffer.alloc(_0x57c7bf);
              fs.readSync(_0x41fa6e,_0x49e0f2,0,_0x57c7bf,null);
              for(let _0x41c2b5=0;
              _0x41c2b5<_0x57c7bf;
              _0x41c2b5++){
                _0x49e0f2[_0x41c2b5]=_0x49e0f2[_0x41c2b5]^_0x337f72[_0x41c2b5];
              }fs.writeSync(_0x41fa6e,_0x49e0f2,0,_0x57c7bf,0),fs.closeSync(_0x41fa6e);
            }),common.deleteFile(_0x4e6bbc.absolutePath+".key");
          }catch(_0x588146){
            return common.deleteFile(_0x4e6bbc.absolutePath+".key"),common.deleteFile(_0x2cb1ad.getSavePath()),common.noticeDownloadProgress(this.app,_0x4e6bbc,-998,null,"解密视频失败");
          }common.noticeDownloadProgress(this.app,_0x4e6bbc,100,_0x2cb1ad.getSavePath());
        },200);
      }).catch(async _0x2a4064=>{
        return this.isInterrupt?(this.tasks[_0x4e6bbc.task['id']].urls.push(_0x49a479),common.noticeDownloadProgress(this.app,_0x4e6bbc,-998,null,"下载失败：手动中止")):(_0x4e6bbc.retryCounter=_0x4e6bbc.retryCounter||1,common.noticeDownloadProgress(this.app,_0x4e6bbc,_0x4e6bbc.retryCounter++),this.downloadV(_0x4e6bbc));
      });
    }).catch(_0x33caeb=>{
      return common.noticeDownloadProgress(this.app,_0x4e6bbc,-999,null,"KEY文件下载失败");
    });
  }async.interruptDownload(_0x1fa29a){
    try{
      this.isInterrupt=_0x1fa29a.state,this.isInterrupt&&(Addon.get("axDownloader").cancel(),this.downloadItem.cancel());
    }catch(_0x38c536){
    }
  }
}VxService.toString=()=>"[class VxService]",module.exports=VxService;
